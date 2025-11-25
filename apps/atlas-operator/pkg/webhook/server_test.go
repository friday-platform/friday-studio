package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// mockReconciler implements the Reconciler interface for testing.
type mockReconciler struct {
	reconcileCalled bool
	shouldFail      bool
}

func (m *mockReconciler) Reconcile(ctx context.Context) error {
	m.reconcileCalled = true
	if m.shouldFail {
		return fmt.Errorf("reconciliation failed")
	}
	return nil
}

func TestHandleRefresh_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	server := NewServer(reconciler, "", logger)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/refresh", nil)
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	// Check response status
	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	// Check reconciler was called
	if !reconciler.reconcileCalled {
		t.Error("expected reconciler to be called")
	}

	// Check response body
	var resp RefreshResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "success" {
		t.Errorf("expected status 'success', got '%s'", resp.Status)
	}

	if resp.Message != "reconciliation triggered successfully" {
		t.Errorf("unexpected message: %s", resp.Message)
	}
}

func TestHandleRefresh_MethodNotAllowed(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	server := NewServer(reconciler, "", logger)

	// Test GET request
	req := httptest.NewRequest(http.MethodGet, "/api/v1/refresh", nil)
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", w.Code)
	}

	if reconciler.reconcileCalled {
		t.Error("reconciler should not be called for GET request")
	}
}

func TestHandleRefresh_WithValidToken(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	token := "test-secret-token"
	server := NewServer(reconciler, token, logger)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/refresh", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	if !reconciler.reconcileCalled {
		t.Error("expected reconciler to be called with valid token")
	}
}

func TestHandleRefresh_WithInvalidToken(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	token := "test-secret-token"
	server := NewServer(reconciler, token, logger)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/refresh", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status 401, got %d", w.Code)
	}

	if reconciler.reconcileCalled {
		t.Error("reconciler should not be called with invalid token")
	}

	var resp RefreshResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "error" {
		t.Errorf("expected status 'error', got '%s'", resp.Status)
	}
}

func TestHandleRefresh_MissingAuthorizationHeader(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	token := "test-secret-token"
	server := NewServer(reconciler, token, logger)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/refresh", nil)
	// No Authorization header
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status 401, got %d", w.Code)
	}

	if reconciler.reconcileCalled {
		t.Error("reconciler should not be called without authorization header")
	}
}

func TestHandleRefresh_ReconciliationFailure(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{shouldFail: true}
	server := NewServer(reconciler, "", logger)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/refresh", nil)
	w := httptest.NewRecorder()

	server.handleRefresh(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected status 500, got %d", w.Code)
	}

	if !reconciler.reconcileCalled {
		t.Error("expected reconciler to be called")
	}

	var resp RefreshResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "error" {
		t.Errorf("expected status 'error', got '%s'", resp.Status)
	}
}

func TestHealthEndpoint(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	reconciler := &mockReconciler{}
	server := NewServer(reconciler, "", logger)

	// Create test server with mux
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/refresh", server.handleRefresh)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()

	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	if w.Body.String() != "OK" {
		t.Errorf("expected body 'OK', got '%s'", w.Body.String())
	}
}

func TestAuthMiddleware(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	token := "test-token"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("success"))
	})

	middleware := AuthMiddleware(token, logger)
	wrappedHandler := middleware(handler)

	tests := []struct {
		name           string
		authHeader     string
		expectedStatus int
		expectedBody   string
	}{
		{
			name:           "valid token",
			authHeader:     "Bearer test-token",
			expectedStatus: http.StatusOK,
			expectedBody:   "success",
		},
		{
			name:           "invalid token",
			authHeader:     "Bearer wrong-token",
			expectedStatus: http.StatusUnauthorized,
			expectedBody:   "unauthorized",
		},
		{
			name:           "missing bearer prefix",
			authHeader:     "test-token",
			expectedStatus: http.StatusUnauthorized,
			expectedBody:   "unauthorized",
		},
		{
			name:           "missing auth header",
			authHeader:     "",
			expectedStatus: http.StatusUnauthorized,
			expectedBody:   "unauthorized",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			w := httptest.NewRecorder()

			wrappedHandler.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}

			if w.Body.String() != tt.expectedBody {
				t.Errorf("expected body '%s', got '%s'", tt.expectedBody, w.Body.String())
			}
		})
	}
}

func TestAuthMiddleware_NoTokenRequired(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("success"))
	})

	middleware := AuthMiddleware("", logger) // Empty token = no auth required
	wrappedHandler := middleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	// No Authorization header
	w := httptest.NewRecorder()

	wrappedHandler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	if w.Body.String() != "success" {
		t.Errorf("expected body 'success', got '%s'", w.Body.String())
	}
}
