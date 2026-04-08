package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestRouter creates an EventRouter pointing at the given atlasd URL.
func newTestRouter(ctx context.Context, atlasURL string) *EventRouter {
	return NewEventRouter(ctx, 5*time.Second, atlasURL)
}

// newTestMux wires the handler into a chi router with the real route pattern.
func newTestMux(router *EventRouter) *chi.Mux {
	logger := httplog.NewLogger("test", httplog.Options{LogLevel: 100}) // suppress logs
	mux := chi.NewRouter()
	mux.Use(httplog.RequestLogger(logger, nil))
	mux.Post("/webhook/slack/{userID}/{appID}", handlePerAppSlackWebhook(router))
	return mux
}

func TestURLVerification(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := newTestRouter(ctx, "http://unused:9999")
	mux := newTestMux(router)

	body := `{"type":"url_verification","challenge":"abc123"}`
	req := httptest.NewRequest("POST", "/webhook/slack/user1/app1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	resp := w.Result()
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "text/plain", resp.Header.Get("Content-Type"))

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Equal(t, "abc123", string(respBody))
}

func TestRetryAck(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := newTestRouter(ctx, "http://unused:9999")
	mux := newTestMux(router)

	req := httptest.NewRequest("POST", "/webhook/slack/user1/app1", strings.NewReader(`{}`))
	req.Header.Set("X-Slack-Retry-Num", "1")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Result().StatusCode)
}

func TestRawForwarding(t *testing.T) {
	var (
		mu              sync.Mutex
		receivedBody    string
		receivedHeaders http.Header
	)

	// Mock atlasd server that captures the forwarded request.
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		receivedBody = string(b)
		receivedHeaders = r.Header.Clone()
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer atlasd.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := newTestRouter(ctx, atlasd.URL)
	mux := newTestMux(router)

	eventBody := `{"type":"event_callback","event":{"type":"message","text":"hello"}}`
	req := httptest.NewRequest("POST", "/webhook/slack/user1/app1", strings.NewReader(eventBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Slack-Request-Timestamp", "1234567890")
	req.Header.Set("X-Slack-Signature", "v0=deadbeef")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	// Handler acks immediately.
	assert.Equal(t, http.StatusOK, w.Result().StatusCode)

	// Wait for the async goroutine to forward the request.
	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return receivedBody != ""
	}, 2*time.Second, 10*time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	assert.Equal(t, eventBody, receivedBody)
	assert.Equal(t, "application/json", receivedHeaders.Get("Content-Type"))
	assert.Equal(t, "1234567890", receivedHeaders.Get("X-Slack-Request-Timestamp"))
	assert.Equal(t, "v0=deadbeef", receivedHeaders.Get("X-Slack-Signature"))
}
