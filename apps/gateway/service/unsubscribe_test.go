package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tempestteam/atlas/apps/gateway/repo"
)

// --- Unit tests (no DB required) ---

func TestGenerateAndVerifyToken(t *testing.T) {
	key := "test-hmac-secret-key"
	email := "user@example.com"
	workspaceID := "ws-123"
	userID := "usr-456"

	token := generateUnsubscribeToken(key, email, workspaceID, userID)

	payload, err := verifyUnsubscribeToken(key, token)
	require.NoError(t, err)
	assert.Equal(t, email, payload.Email)
	assert.Equal(t, workspaceID, payload.WorkspaceID)
	assert.Equal(t, userID, payload.UserID)
	assert.WithinDuration(t, time.Now(), time.Unix(payload.Timestamp, 0), 5*time.Second)
}

func TestVerifyToken_WrongKey(t *testing.T) {
	token := generateUnsubscribeToken("key-a", "user@example.com", "ws-1", "usr-1")

	_, err := verifyUnsubscribeToken("key-b", token)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid signature")
}

func TestVerifyToken_Tampered(t *testing.T) {
	token := generateUnsubscribeToken("secret", "user@example.com", "ws-1", "usr-1")

	parts := strings.SplitN(token, ".", 2)
	require.Len(t, parts, 2)
	tampered := parts[0] + "." + strings.Replace(parts[1], "user@example.com", "evil@attacker.com", 1)

	_, err := verifyUnsubscribeToken("secret", tampered)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid signature")
}

func TestVerifyToken_Expired(t *testing.T) {
	key := "secret"
	email := "user@example.com"
	workspaceID := "ws-1"
	oldTS := time.Now().Add(-31 * 24 * time.Hour).Unix()

	payload := fmt.Sprintf("%s|%s|%s|%d", email, workspaceID, "usr-1", oldTS)
	sig := testHMACSHA256(key, payload)
	token := sig + "." + payload

	_, err := verifyUnsubscribeToken(key, token)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "expired")
}

func TestVerifyToken_Malformed(t *testing.T) {
	tests := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"no dot", "abcdef1234"},
		{"bad hex sig", "zzzz.user@example.com|ws-1|usr-1|12345"},
		{"missing fields", "abcd.user@example.com|ws-1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := verifyUnsubscribeToken("secret", tt.token)
			assert.Error(t, err)
		})
	}
}

func TestHandleUnsubscribePage_InvalidToken(t *testing.T) {
	svc := newTestServiceForUnsubscribe()

	req := httptest.NewRequest(http.MethodGet, "/unsubscribe?token=bad-token", nil)
	rec := httptest.NewRecorder()

	svc.HandleUnsubscribePage(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Invalid Link")
}

func TestHandleUnsubscribe_MissingToken(t *testing.T) {
	svc := newTestServiceForUnsubscribe()

	req := httptest.NewRequest(http.MethodPost, "/unsubscribe", nil)
	rec := httptest.NewRecorder()

	svc.HandleUnsubscribe(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "missing token")
}

// --- Integration tests (require POSTGRES_CONNECTION env var) ---

func TestHandleUnsubscribe_StoresAndChecksSuppression(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-int")

	email := "user@test.com"
	workspaceID := "ws-integration"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID, "usr-int")

	// Not suppressed yet
	assert.False(t, svc.isEmailSuppressed(context.Background(), email, workspaceID))
	t.Cleanup(func() {
		_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", email)
	})

	// POST unsubscribe
	form := url.Values{}
	form.Set("token", token)
	req := httptest.NewRequest(http.MethodPost, "/unsubscribe", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	svc.HandleUnsubscribe(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "unsubscribed")

	// Now suppressed
	assert.True(t, svc.isEmailSuppressed(context.Background(), email, workspaceID))

	// Different workspace is NOT suppressed
	assert.False(t, svc.isEmailSuppressed(context.Background(), email, "ws-other"))
}

func TestHandleUnsubscribePage_RendersConfirmation(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-page")

	email := "page-user@test.com"
	workspaceID := "ws-page"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID, "usr-page")

	req := httptest.NewRequest(http.MethodGet, "/unsubscribe?token="+url.QueryEscape(token), nil)
	rec := httptest.NewRecorder()

	svc.HandleUnsubscribePage(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")

	body := rec.Body.String()
	assert.Contains(t, body, "Confirm Unsubscribe")
	assert.Contains(t, body, `method="POST"`)
	assert.Contains(t, body, "Unsubscribe from ws-page?")

	// GET must NOT store a suppression
	assert.False(t, svc.isEmailSuppressed(context.Background(), email, workspaceID))
}

func TestHandleUnsubscribe_Idempotent(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-idem")

	email := "idempotent@test.com"
	workspaceID := "ws-idem"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID, "usr-idem")

	t.Cleanup(func() {
		_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", email)
	})

	// Unsubscribe twice — second should not error
	for i := 0; i < 2; i++ {
		form := url.Values{}
		form.Set("token", token)
		req := httptest.NewRequest(http.MethodPost, "/unsubscribe", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		svc.HandleUnsubscribe(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	}
}

func TestWithUserContext_SetsSessionVariable(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-rls")

	// Insert via withUserContext — user_id column DEFAULT reads from request.user_id session var.
	// If set_config didn't work, the DEFAULT would be empty and the FK would reject the insert.
	err := withUserContext(context.Background(), svc.db, "usr-rls", func(q *repo.Queries) error {
		return q.StoreSuppression(context.Background(), repo.StoreSuppressionParams{
			Email:       "session-test@test.com",
			WorkspaceID: "ws-session",
			RemoteIp:    "1.2.3.4",
		})
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", "session-test@test.com")
	})

	// Verify user_id was populated from the session variable
	var storedUserID string
	err = svc.db.QueryRow(context.Background(),
		"SELECT user_id FROM gateway.email_suppressions WHERE email = 'session-test@test.com'").Scan(&storedUserID)
	require.NoError(t, err)
	assert.Equal(t, "usr-rls", storedUserID)
}

func TestWithUserContext_RollsBackOnError(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-rollback")

	err := withUserContext(context.Background(), svc.db, "usr-rollback", func(q *repo.Queries) error {
		// Insert a row, then return an error — should be rolled back
		_ = q.StoreSuppression(context.Background(), repo.StoreSuppressionParams{
			Email:       "rollback@test.com",
			WorkspaceID: "ws-rollback",
			RemoteIp:    "1.2.3.4",
		})
		return fmt.Errorf("simulated error")
	})
	require.Error(t, err)

	// Row should NOT exist (transaction rolled back)
	assert.False(t, svc.isEmailSuppressed(context.Background(), "rollback@test.com", "ws-rollback"))
}

func TestWithUserContext_RLSIsolation(t *testing.T) {
	svc := newTestServiceWithDB(t)
	ensureTestUser(t, svc, "usr-rls-a")
	ensureTestUser(t, svc, "usr-rls-b")

	// Insert as user A
	err := withUserContext(context.Background(), svc.db, "usr-rls-a", func(q *repo.Queries) error {
		return q.StoreSuppression(context.Background(), repo.StoreSuppressionParams{
			Email:       "rls-test@test.com",
			WorkspaceID: "ws-rls",
			RemoteIp:    "1.2.3.4",
		})
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", "rls-test@test.com")
	})

	// User B should NOT see user A's row via RLS
	// Query through a manual tx with user B's context to verify isolation
	var count int
	tx, err := svc.db.Begin(context.Background())
	require.NoError(t, err)
	_, err = tx.Exec(context.Background(), "SET LOCAL ROLE authenticated")
	require.NoError(t, err)
	_, err = tx.Exec(context.Background(), "SELECT set_config('request.user_id', $1, true)", "usr-rls-b")
	require.NoError(t, err)
	err = tx.QueryRow(context.Background(),
		"SELECT count(*) FROM gateway.email_suppressions WHERE email = 'rls-test@test.com'").Scan(&count)
	_ = tx.Rollback(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0, count)

	// Superuser (bare query, no RLS context) CAN see the row — isEmailSuppressed uses this path
	assert.True(t, svc.isEmailSuppressed(context.Background(), "rls-test@test.com", "ws-rls"))
}

func TestWorkspaceDisplayName(t *testing.T) {
	tests := []struct {
		id   string
		want string
	}{
		{"friday-conversation", "chat"},
		{"my-workspace", "my-workspace"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			assert.Equal(t, tt.want, workspaceDisplayName(tt.id))
		})
	}
}

func TestStripPort(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"192.168.1.1:54321", "192.168.1.1"},
		{"10.0.0.1:80", "10.0.0.1"},
		{"192.168.1.1", "192.168.1.1"},       // bare IPv4 (middleware.RealIP)
		{"[::1]:8080", "::1"},                // IPv6 with port
		{"::1", "::1"},                       // bare IPv6
		{"2001:db8::1", "2001:db8::1"},       // bare IPv6 full
		{"[2001:db8::1]:443", "2001:db8::1"}, // IPv6 with port
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.want, stripPort(tt.input))
		})
	}
}

func TestIsEmailSuppressed_NilQueries_FailsOpen(t *testing.T) {
	svc := &Service{
		Logger:  testLogger(),
		queries: nil, // no DB configured
	}
	// Must return false (fail open) — never silently drop emails when DB is unavailable.
	assert.False(t, svc.isEmailSuppressed(context.Background(), "user@example.com", "ws-1"))
}

// --- Test helpers ---

func newTestServiceForUnsubscribe() *Service {
	return &Service{
		Logger: httplog.NewLogger("test", httplog.Options{
			LogLevel: slog.LevelError,
			JSON:     false,
		}),
		cfg: Config{
			UnsubscribeHMACKey: "test-secret",
			UnsubscribeBaseURL: "https://gateway.test",
		},
		client: &http.Client{},
	}
}

func newTestServiceWithDB(t *testing.T) *Service {
	t.Helper()

	connString := os.Getenv("POSTGRES_CONNECTION")
	if connString == "" {
		t.Skip("POSTGRES_CONNECTION not set — skipping integration test")
	}

	pool, err := repo.NewPool(context.Background(), connString)
	require.NoError(t, err)
	t.Cleanup(func() { pool.Close() })

	return &Service{
		Logger: httplog.NewLogger("test", httplog.Options{
			LogLevel: slog.LevelError,
			JSON:     false,
		}),
		cfg: Config{
			UnsubscribeHMACKey: "test-integration-secret",
			UnsubscribeBaseURL: "https://gateway.test",
			PostgresConnection: connString,
		},
		client:  &http.Client{},
		db:      pool,
		queries: repo.New(pool),
	}
}

// ensureTestUser creates a test user in public.user if it doesn't exist (FK target).
func ensureTestUser(t *testing.T, svc *Service, userID string) {
	t.Helper()
	_, err := svc.db.Exec(context.Background(),
		`INSERT INTO public."user" (id, full_name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
		userID, "Test User "+userID, userID+"@test.local")
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = svc.db.Exec(context.Background(), `DELETE FROM public."user" WHERE id = $1`, userID)
	})
}

func testHMACSHA256(key, payload string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}
