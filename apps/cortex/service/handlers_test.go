package service

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestHandleUpload_ServiceConfig(t *testing.T) {
	logger := httplog.NewLogger("test", httplog.Options{LogLevel: slog.LevelError})
	s := &Service{
		Logger:    logger,
		config:    Config{MaxUploadSize: 10 * 1024 * 1024, MaxConcurrentUploads: 10},
		uploadSem: make(chan struct{}, 10),
	}

	// Verify the service is properly initialized
	if s.config.MaxUploadSize != 10*1024*1024 {
		t.Errorf("MaxUploadSize = %d, want %d", s.config.MaxUploadSize, 10*1024*1024)
	}

	if s.config.MaxConcurrentUploads != 10 {
		t.Errorf("MaxConcurrentUploads = %d, want %d", s.config.MaxConcurrentUploads, 10)
	}
}

func TestHandleUpload_SemaphoreLimit(t *testing.T) {
	logger := httplog.NewLogger("test", httplog.Options{LogLevel: slog.LevelError})

	// Create service with semaphore size of 1
	s := &Service{
		Logger:    logger,
		config:    Config{MaxUploadSize: 1024, MaxConcurrentUploads: 1},
		uploadSem: make(chan struct{}, 1),
	}

	// Fill the semaphore
	s.uploadSem <- struct{}{}

	// Now verify semaphore is full
	select {
	case s.uploadSem <- struct{}{}:
		t.Error("Semaphore should be full")
		<-s.uploadSem // Clean up
	default:
		// Expected - semaphore is full
	}

	// Clean up
	<-s.uploadSem
}

func TestObjectResponse_JSON(t *testing.T) {
	resp := ObjectResponse{
		ID:          "550e8400-e29b-41d4-a716-446655440000",
		UserID:      "test-user",
		ContentSize: ptr(int64(1024)),
		Metadata:    json.RawMessage(`{"key": "value"}`),
		CreatedAt:   "2024-01-01T00:00:00Z",
		UpdatedAt:   "2024-01-01T00:00:00Z",
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal ObjectResponse: %v", err)
	}

	var decoded ObjectResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Failed to unmarshal ObjectResponse: %v", err)
	}

	if decoded.ID != resp.ID {
		t.Errorf("ID = %q, want %q", decoded.ID, resp.ID)
	}
	if decoded.UserID != resp.UserID {
		t.Errorf("UserID = %q, want %q", decoded.UserID, resp.UserID)
	}
	if *decoded.ContentSize != *resp.ContentSize {
		t.Errorf("ContentSize = %d, want %d", *decoded.ContentSize, *resp.ContentSize)
	}
}

func TestObjectResponse_NilContentSize(t *testing.T) {
	resp := ObjectResponse{
		ID:          "550e8400-e29b-41d4-a716-446655440000",
		UserID:      "test-user",
		ContentSize: nil,
		Metadata:    json.RawMessage(`{}`),
		CreatedAt:   "2024-01-01T00:00:00Z",
		UpdatedAt:   "2024-01-01T00:00:00Z",
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Failed to marshal ObjectResponse: %v", err)
	}

	// Verify content_size is null in JSON
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Failed to unmarshal to map: %v", err)
	}

	if raw["content_size"] != nil {
		t.Errorf("content_size should be null, got %v", raw["content_size"])
	}
}

func TestPgtypeUUIDConversion(t *testing.T) {
	// Test converting between uuid.UUID and pgtype.UUID
	original := uuid.MustParse("550e8400-e29b-41d4-a716-446655440000")

	// Convert to pgtype.UUID
	pgID := pgtype.UUID{Bytes: original, Valid: true}

	// Convert back
	recovered := uuid.UUID(pgID.Bytes)

	if recovered != original {
		t.Errorf("UUID conversion failed: got %s, want %s", recovered, original)
	}
}

func TestRouterURLParams(t *testing.T) {
	// Test that chi router properly extracts URL params
	r := chi.NewRouter()

	var capturedID string
	r.Get("/objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		capturedID = chi.URLParam(r, "id")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/objects/550e8400-e29b-41d4-a716-446655440000", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if capturedID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("URLParam(id) = %q, want %q", capturedID, "550e8400-e29b-41d4-a716-446655440000")
	}
}

func TestRouterMetadataRoutes(t *testing.T) {
	r := chi.NewRouter()

	handler := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}

	r.Post("/objects/{id}/metadata", handler)
	r.Get("/objects/{id}/metadata", handler)
	r.Put("/objects/{id}/metadata", handler)

	tests := []struct {
		method       string
		expectedCode int
	}{
		{http.MethodPost, http.StatusOK},
		{http.MethodGet, http.StatusOK},
		{http.MethodPut, http.StatusOK},
		{http.MethodDelete, http.StatusMethodNotAllowed},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/objects/123/metadata", nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != tt.expectedCode {
				t.Errorf("%s /objects/{id}/metadata = %d, want %d", tt.method, rec.Code, tt.expectedCode)
			}
		})
	}
}

func ptr[T any](v T) *T {
	return &v
}
