package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func ptr(s string) *string { return &s }

func TestMeResponse_JSON(t *testing.T) {
	resp := MeResponse{
		ID:           "test-user-id",
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    "2024-01-01T00:00:00.000000Z",
		UpdatedAt:    "2024-01-02T00:00:00.000000Z",
		DisplayName:  ptr("testuser"),
		ProfilePhoto: ptr("https://example.com/photo.jpg"),
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal MeResponse: %v", err)
	}

	var decoded MeResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Failed to unmarshal MeResponse: %v", err)
	}

	if decoded.ID != resp.ID {
		t.Errorf("ID = %q, want %q", decoded.ID, resp.ID)
	}
	if decoded.FullName != resp.FullName {
		t.Errorf("FullName = %q, want %q", decoded.FullName, resp.FullName)
	}
	if decoded.Email != resp.Email {
		t.Errorf("Email = %q, want %q", decoded.Email, resp.Email)
	}
	if *decoded.DisplayName != *resp.DisplayName {
		t.Errorf("DisplayName = %q, want %q", *decoded.DisplayName, *resp.DisplayName)
	}
	if *decoded.ProfilePhoto != *resp.ProfilePhoto {
		t.Errorf("ProfilePhoto = %q, want %q", *decoded.ProfilePhoto, *resp.ProfilePhoto)
	}
}

func TestMeResponse_NullFields(t *testing.T) {
	resp := MeResponse{
		ID:           "test-user-id",
		FullName:     "Test User",
		Email:        "test@example.com",
		CreatedAt:    "2024-01-01T00:00:00.000000Z",
		UpdatedAt:    "2024-01-02T00:00:00.000000Z",
		DisplayName:  nil,
		ProfilePhoto: nil,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal MeResponse: %v", err)
	}

	// Verify nullable fields serialize as null
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Failed to unmarshal to map: %v", err)
	}

	if raw["display_name"] != nil {
		t.Errorf("display_name should be null, got %v", raw["display_name"])
	}
	if raw["profile_photo"] != nil {
		t.Errorf("profile_photo should be null, got %v", raw["profile_photo"])
	}
}

// Note: handleMe requires httplog context from middleware, so we test it
// through integration tests with the full router setup, not unit tests.
// The RLS integration tests in rls_test.go cover the actual handler behavior.

func TestRouterMeEndpoint(t *testing.T) {
	r := chi.NewRouter()

	var capturedPath string
	r.Get("/api/me", func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if capturedPath != "/api/me" {
		t.Errorf("Path = %q, want %q", capturedPath, "/api/me")
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRouterMethodNotAllowed(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/me", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// POST should not be allowed
	req := httptest.NewRequest(http.MethodPost, "/api/me", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/me Status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	data := map[string]string{"key": "value"}

	writeJSON(rec, data, http.StatusOK)

	if rec.Code != http.StatusOK {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusOK)
	}

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var decoded map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&decoded); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if decoded["key"] != "value" {
		t.Errorf("key = %q, want %q", decoded["key"], "value")
	}
}

func TestWriteJSONError(t *testing.T) {
	rec := httptest.NewRecorder()

	writeJSONError(rec, "test error", http.StatusBadRequest)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var decoded map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&decoded); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if decoded["error"] != "test error" {
		t.Errorf("error = %q, want %q", decoded["error"], "test error")
	}
}

func TestDBFromContext_Missing(t *testing.T) {
	ctx := context.Background()
	_, err := DBFromContext(ctx)
	if err == nil {
		t.Error("DBFromContext should return error when pool not in context")
	}
}
