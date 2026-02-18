package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"cloud.google.com/go/bigquery"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// analyticsRow represents a flat row in BigQuery.
type analyticsRow struct {
	Timestamp      time.Time `bigquery:"timestamp"`
	EventName      string    `bigquery:"event_name"`
	EventID        string    `bigquery:"event_id"`
	UserID         string    `bigquery:"user_id"`
	WorkspaceID    string    `bigquery:"workspace_id"`
	SessionID      string    `bigquery:"session_id"`
	ConversationID string    `bigquery:"conversation_id"`
	JobName        string    `bigquery:"job_name"`
	Environment    string    `bigquery:"environment"`
	Metadata       string    `bigquery:"metadata"` // JSON-encoded extra attributes
}

// knownAttributes are extracted into dedicated columns, not included in metadata.
var knownAttributes = map[string]bool{
	"log.type":        true,
	"event_name":      true,
	"event_id":        true,
	"user_id":         true,
	"workspace_id":    true,
	"session_id":      true,
	"conversation_id": true,
	"job_name":        true,
	"environment":     true,
}

// rowInserter abstracts BigQuery insert operations for testing.
type rowInserter interface {
	Put(ctx context.Context, src any) error
}

type bigQueryExporter struct {
	cfg      *Config
	logger   *zap.Logger
	client   *bigquery.Client
	inserter rowInserter
}

func newBigQueryExporter(cfg *Config, logger *zap.Logger) *bigQueryExporter {
	return &bigQueryExporter{
		cfg:    cfg,
		logger: logger,
	}
}

func (e *bigQueryExporter) start(ctx context.Context, _ component.Host) error {
	client, err := bigquery.NewClient(ctx, e.cfg.ProjectID)
	if err != nil {
		return fmt.Errorf("failed to create BigQuery client: %w", err)
	}
	e.client = client
	e.inserter = client.Dataset(e.cfg.DatasetID).Table(e.cfg.TableID).Inserter()
	e.logger.Info("BigQuery exporter started",
		zap.String("project", e.cfg.ProjectID),
		zap.String("dataset", e.cfg.DatasetID),
		zap.String("table", e.cfg.TableID),
	)
	return nil
}

func (e *bigQueryExporter) shutdown(ctx context.Context) error {
	if e.client != nil {
		return e.client.Close()
	}
	return nil
}

func (e *bigQueryExporter) pushLogs(ctx context.Context, ld plog.Logs) error {
	var rows []*analyticsRow

	for i := 0; i < ld.ResourceLogs().Len(); i++ {
		rl := ld.ResourceLogs().At(i)
		for j := 0; j < rl.ScopeLogs().Len(); j++ {
			sl := rl.ScopeLogs().At(j)
			for k := 0; k < sl.LogRecords().Len(); k++ {
				lr := sl.LogRecords().At(k)

				// Only process analytics logs
				logType, exists := lr.Attributes().Get("log.type")
				if !exists || logType.Str() != "analytics" {
					continue
				}

				row := e.extractRow(lr)
				rows = append(rows, row)
			}
		}
	}

	if len(rows) == 0 {
		return nil
	}

	if err := e.inserter.Put(ctx, rows); err != nil {
		e.logger.Error("Failed to insert rows to BigQuery",
			zap.Error(err),
			zap.Int("row_count", len(rows)),
		)
		return fmt.Errorf("bigquery insert failed: %w", err)
	}

	e.logger.Debug("Inserted rows to BigQuery", zap.Int("count", len(rows)))
	return nil
}

func (e *bigQueryExporter) extractRow(lr plog.LogRecord) *analyticsRow {
	row := &analyticsRow{
		Timestamp: lr.Timestamp().AsTime(),
	}

	attrs := lr.Attributes()
	extra := make(map[string]any)

	attrs.Range(func(k string, v pcommon.Value) bool {
		switch k {
		case "event_name":
			row.EventName = v.Str()
		case "event_id":
			row.EventID = v.Str()
		case "user_id":
			row.UserID = v.Str()
		case "workspace_id":
			row.WorkspaceID = v.Str()
		case "session_id":
			row.SessionID = v.Str()
		case "conversation_id":
			row.ConversationID = v.Str()
		case "job_name":
			row.JobName = v.Str()
		case "environment":
			row.Environment = v.Str()
		default:
			if !knownAttributes[k] {
				extra[k] = v.AsRaw()
			}
		}
		return true
	})

	if len(extra) > 0 {
		if data, err := json.Marshal(extra); err == nil {
			row.Metadata = string(data)
		}
	}

	return row
}
