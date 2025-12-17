package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleGetCredentials_NoUserID(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/credentials", nil)
	w := httptest.NewRecorder()

	handleGetCredentials(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	// Verify JSON response with correct Content-Type
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %s", ct)
	}

	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["error"] != "unauthorized" {
		t.Errorf("expected error 'unauthorized', got %q", resp["error"])
	}
}

func TestHandleGetCredentials_NoDeps(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/credentials", nil)
	// Add userID to context but no deps
	ctx := WithUserID(req.Context(), "user-123")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	handleGetCredentials(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}

	// Verify JSON response with correct Content-Type
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %s", ct)
	}

	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["error"] != "internal error" {
		t.Errorf("expected error 'internal error', got %q", resp["error"])
	}
}

func TestHandleGetCredentials_NilQueries(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/credentials", nil)
	// Add userID and deps with nil Queries - should fail safely (not panic)
	ctx := WithUserID(req.Context(), "user-123")
	ctx = context.WithValue(ctx, credentialsDepsContextKey, &CredentialsDeps{
		Queries:     nil, // nil Queries should be caught by CredentialsDepsFromContext
		SendgridKey: "sg-key",
		ParallelKey: "parallel-key",
	})
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	handleGetCredentials(w, req)

	// Should return 500, not panic
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %s", ct)
	}
}
