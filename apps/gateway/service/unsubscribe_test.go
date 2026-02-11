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

	token := generateUnsubscribeToken(key, email, workspaceID)

	payload, err := verifyUnsubscribeToken(key, token)
	require.NoError(t, err)
	assert.Equal(t, email, payload.Email)
	assert.Equal(t, workspaceID, payload.WorkspaceID)
	assert.WithinDuration(t, time.Now(), time.Unix(payload.Timestamp, 0), 5*time.Second)
}

func TestVerifyToken_WrongKey(t *testing.T) {
	token := generateUnsubscribeToken("key-a", "user@example.com", "ws-1")

	_, err := verifyUnsubscribeToken("key-b", token)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid signature")
}

func TestVerifyToken_Tampered(t *testing.T) {
	token := generateUnsubscribeToken("secret", "user@example.com", "ws-1")

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

	payload := fmt.Sprintf("%s|%s|%d", email, workspaceID, oldTS)
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
		{"bad hex sig", "zzzz.user@example.com|ws-1|12345"},
		{"missing fields", "abcd.user@example.com"},
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

	email := "user@test.com"
	workspaceID := "ws-integration"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID)

	// Not suppressed yet
	assert.False(t, svc.isEmailSuppressed(context.Background(), email, workspaceID))

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

	// Cleanup
	_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", email)
}

func TestHandleUnsubscribePage_RendersConfirmation(t *testing.T) {
	svc := newTestServiceWithDB(t)

	email := "page-user@test.com"
	workspaceID := "ws-page"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID)

	req := httptest.NewRequest(http.MethodGet, "/unsubscribe?token="+url.QueryEscape(token), nil)
	rec := httptest.NewRecorder()

	svc.HandleUnsubscribePage(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")

	body := rec.Body.String()
	assert.Contains(t, body, "Confirm Unsubscribe")
	assert.Contains(t, body, `method="POST"`)

	// GET must NOT store a suppression
	assert.False(t, svc.isEmailSuppressed(context.Background(), email, workspaceID))
}

func TestHandleUnsubscribe_Idempotent(t *testing.T) {
	svc := newTestServiceWithDB(t)

	email := "idempotent@test.com"
	workspaceID := "ws-idem"
	token := generateUnsubscribeToken(svc.cfg.UnsubscribeHMACKey, email, workspaceID)

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

	// Cleanup
	_, _ = svc.db.Exec(context.Background(), "DELETE FROM gateway.email_suppressions WHERE email = $1", email)
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

func testHMACSHA256(key, payload string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}
