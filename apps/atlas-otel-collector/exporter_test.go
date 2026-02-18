package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// mockInserter implements rowInserter for testing.
type mockInserter struct {
	rows   []*analyticsRow
	err    error
	called bool
}

func (m *mockInserter) Put(_ context.Context, src any) error {
	m.called = true
	if rows, ok := src.([]*analyticsRow); ok {
		m.rows = rows
	}
	return m.err
}

func TestExtractRow(t *testing.T) {
	exp := newBigQueryExporter(&Config{}, zap.NewNop())

	tests := []struct {
		name     string
		setup    func(lr plog.LogRecord)
		expected analyticsRow
	}{
		{
			name: "extracts all attributes",
			setup: func(lr plog.LogRecord) {
				lr.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)))
				lr.Attributes().PutStr("event_name", "signup_completed")
				lr.Attributes().PutStr("event_id", "evt-123")
				lr.Attributes().PutStr("user_id", "user-456")
				lr.Attributes().PutStr("workspace_id", "ws-789")
				lr.Attributes().PutStr("session_id", "sess-abc")
				lr.Attributes().PutStr("conversation_id", "conv-def")
				lr.Attributes().PutStr("job_name", "signup-job")
				lr.Attributes().PutStr("environment", "production")
			},
			expected: analyticsRow{
				Timestamp:      time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
				EventName:      "signup_completed",
				EventID:        "evt-123",
				UserID:         "user-456",
				WorkspaceID:    "ws-789",
				SessionID:      "sess-abc",
				ConversationID: "conv-def",
				JobName:        "signup-job",
				Environment:    "production",
			},
		},
		{
			name: "handles missing attributes",
			setup: func(lr plog.LogRecord) {
				lr.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)))
				lr.Attributes().PutStr("event_name", "user_logout")
				lr.Attributes().PutStr("user_id", "user-123")
			},
			expected: analyticsRow{
				Timestamp: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
				EventName: "user_logout",
				UserID:    "user-123",
			},
		},
		{
			name: "handles empty log record",
			setup: func(lr plog.LogRecord) {
				lr.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)))
			},
			expected: analyticsRow{
				Timestamp: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
			},
		},
		{
			name: "captures extra attributes in metadata",
			setup: func(lr plog.LogRecord) {
				lr.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)))
				lr.Attributes().PutStr("event_name", "signup.email_sent")
				lr.Attributes().PutStr("user_id", "user-123")
				lr.Attributes().PutStr("email", "test@example.com")
				lr.Attributes().PutStr("log.type", "analytics") // known attr, should not appear in metadata
			},
			expected: analyticsRow{
				Timestamp: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
				EventName: "signup.email_sent",
				UserID:    "user-123",
				Metadata:  `{"email":"test@example.com"}`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lr := plog.NewLogRecord()
			tt.setup(lr)

			row := exp.extractRow(lr)

			if row.Timestamp != tt.expected.Timestamp {
				t.Errorf("Timestamp = %v, want %v", row.Timestamp, tt.expected.Timestamp)
			}
			if row.EventName != tt.expected.EventName {
				t.Errorf("EventName = %q, want %q", row.EventName, tt.expected.EventName)
			}
			if row.EventID != tt.expected.EventID {
				t.Errorf("EventID = %q, want %q", row.EventID, tt.expected.EventID)
			}
			if row.UserID != tt.expected.UserID {
				t.Errorf("UserID = %q, want %q", row.UserID, tt.expected.UserID)
			}
			if row.WorkspaceID != tt.expected.WorkspaceID {
				t.Errorf("WorkspaceID = %q, want %q", row.WorkspaceID, tt.expected.WorkspaceID)
			}
			if row.SessionID != tt.expected.SessionID {
				t.Errorf("SessionID = %q, want %q", row.SessionID, tt.expected.SessionID)
			}
			if row.ConversationID != tt.expected.ConversationID {
				t.Errorf("ConversationID = %q, want %q", row.ConversationID, tt.expected.ConversationID)
			}
			if row.JobName != tt.expected.JobName {
				t.Errorf("JobName = %q, want %q", row.JobName, tt.expected.JobName)
			}
			if row.Environment != tt.expected.Environment {
				t.Errorf("Environment = %q, want %q", row.Environment, tt.expected.Environment)
			}
			if row.Metadata != tt.expected.Metadata {
				t.Errorf("Metadata = %q, want %q", row.Metadata, tt.expected.Metadata)
			}
		})
	}
}

func TestPushLogsEmptyLogs(t *testing.T) {
	mock := &mockInserter{}
	exp := newBigQueryExporter(&Config{}, zap.NewNop())
	exp.inserter = mock

	err := exp.pushLogs(context.Background(), plog.NewLogs())
	if err != nil {
		t.Errorf("pushLogs() error = %v, want nil", err)
	}
	if mock.called {
		t.Error("inserter.Put() was called for empty logs")
	}
}

func TestPushLogsNoAnalyticsLogs(t *testing.T) {
	mock := &mockInserter{}
	exp := newBigQueryExporter(&Config{}, zap.NewNop())
	exp.inserter = mock

	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	sl := rl.ScopeLogs().AppendEmpty()

	// Non-analytics logs only
	lr1 := sl.LogRecords().AppendEmpty()
	lr1.Attributes().PutStr("log.type", "application")

	lr2 := sl.LogRecords().AppendEmpty()
	lr2.Attributes().PutStr("event_name", "no_type")

	err := exp.pushLogs(context.Background(), ld)
	if err != nil {
		t.Errorf("pushLogs() error = %v, want nil", err)
	}
	if mock.called {
		t.Error("inserter.Put() was called when no analytics logs")
	}
}

func TestPushLogsFiltersAndInserts(t *testing.T) {
	mock := &mockInserter{}
	exp := newBigQueryExporter(&Config{}, zap.NewNop())
	exp.inserter = mock

	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	sl := rl.ScopeLogs().AppendEmpty()

	// Non-analytics log (should be skipped)
	lr1 := sl.LogRecords().AppendEmpty()
	lr1.Attributes().PutStr("log.type", "application")
	lr1.Attributes().PutStr("event_name", "should_skip")

	// Analytics log (should be processed)
	lr2 := sl.LogRecords().AppendEmpty()
	lr2.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)))
	lr2.Attributes().PutStr("log.type", "analytics")
	lr2.Attributes().PutStr("event_name", "signup_completed")
	lr2.Attributes().PutStr("user_id", "user-123")

	// Another analytics log
	lr3 := sl.LogRecords().AppendEmpty()
	lr3.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2024, 1, 15, 11, 0, 0, 0, time.UTC)))
	lr3.Attributes().PutStr("log.type", "analytics")
	lr3.Attributes().PutStr("event_name", "user_logout")
	lr3.Attributes().PutStr("user_id", "user-456")

	err := exp.pushLogs(context.Background(), ld)
	if err != nil {
		t.Errorf("pushLogs() error = %v, want nil", err)
	}
	if !mock.called {
		t.Fatal("inserter.Put() was not called")
	}
	if len(mock.rows) != 2 {
		t.Fatalf("inserted %d rows, want 2", len(mock.rows))
	}

	// Verify first row
	if mock.rows[0].EventName != "signup_completed" {
		t.Errorf("rows[0].EventName = %q, want %q", mock.rows[0].EventName, "signup_completed")
	}
	if mock.rows[0].UserID != "user-123" {
		t.Errorf("rows[0].UserID = %q, want %q", mock.rows[0].UserID, "user-123")
	}

	// Verify second row
	if mock.rows[1].EventName != "user_logout" {
		t.Errorf("rows[1].EventName = %q, want %q", mock.rows[1].EventName, "user_logout")
	}
	if mock.rows[1].UserID != "user-456" {
		t.Errorf("rows[1].UserID = %q, want %q", mock.rows[1].UserID, "user-456")
	}
}

func TestPushLogsInsertError(t *testing.T) {
	mock := &mockInserter{err: errors.New("bigquery error")}
	exp := newBigQueryExporter(&Config{}, zap.NewNop())
	exp.inserter = mock

	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	sl := rl.ScopeLogs().AppendEmpty()
	lr := sl.LogRecords().AppendEmpty()
	lr.Attributes().PutStr("log.type", "analytics")
	lr.Attributes().PutStr("event_name", "test_event")

	err := exp.pushLogs(context.Background(), ld)
	if err == nil {
		t.Error("pushLogs() error = nil, want error")
	}
	if !mock.called {
		t.Error("inserter.Put() was not called")
	}
}

func TestShutdownNilClient(t *testing.T) {
	exp := newBigQueryExporter(&Config{}, zap.NewNop())

	err := exp.shutdown(context.Background())
	if err != nil {
		t.Errorf("shutdown() error = %v, want nil", err)
	}
}
