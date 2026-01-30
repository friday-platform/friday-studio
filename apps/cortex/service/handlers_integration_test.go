package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

// Compile-time check that mockStorage implements Storage interface.
var _ Storage = (*mockStorage)(nil)

// mockStorage implements Storage interface in-memory for testing.
type mockStorage struct {
	objects         map[uuid.UUID][]byte
	uploadErr       error // when set, Upload returns this error
	uploadFailAfter int64 // when >0, read this many bytes then fail (simulates mid-stream failure)
}

func newMockStorage() *mockStorage {
	return &mockStorage{
		objects: make(map[uuid.UUID][]byte),
	}
}

func (m *mockStorage) Upload(_ context.Context, id uuid.UUID, data io.Reader) (int64, error) {
	if m.uploadErr != nil {
		return 0, m.uploadErr
	}
	if m.uploadFailAfter > 0 {
		// Read exactly uploadFailAfter bytes, then return an error
		buf := make([]byte, m.uploadFailAfter)
		n, _ := io.ReadFull(data, buf)
		return int64(n), errors.New("simulated mid-stream failure")
	}
	content, err := io.ReadAll(data)
	if err != nil {
		return 0, err
	}
	m.objects[id] = content
	return int64(len(content)), nil
}

func (m *mockStorage) Download(_ context.Context, id uuid.UUID) (io.ReadCloser, error) {
	content, ok := m.objects[id]
	if !ok {
		return nil, io.EOF
	}
	return io.NopCloser(bytes.NewReader(content)), nil
}

// integrationTestService creates a real service with DB pool and mock storage.
func integrationTestService(t *testing.T, pool *pgxpool.Pool) (*Service, *mockStorage) {
	t.Helper()

	mock := newMockStorage()

	logger := httplog.NewLogger("test", httplog.Options{
		LogLevel: slog.LevelError,
	})

	s := &Service{
		Logger:    logger,
		config:    Config{MaxUploadSize: 10 * 1024 * 1024, MaxConcurrentUploads: 10},
		pool:      pool,
		uploadSem: make(chan struct{}, 10),
	}

	return s, mock
}

// testRouter creates a chi router with test middleware that injects user context.
func testRouter(s *Service, userID string, pool *pgxpool.Pool, storage *mockStorage) http.Handler {
	r := chi.NewRouter()

	// Inject test user ID
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := jwt.WithUserID(r.Context(), userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})

	// Inject DB pool
	r.Use(DBCtxMiddleware(pool))

	// Inject mock storage (implements Storage interface)
	r.Use(StorageCtxMiddleware(storage))

	r.Post("/objects", s.HandleUpload)
	r.Get("/objects", s.HandleList)
	r.Get("/objects/{id}", s.HandleDownload)
	r.Put("/objects/{id}", s.HandleUpdate)
	r.Delete("/objects/{id}", s.HandleDelete)
	r.Post("/objects/{id}/metadata", s.HandleSetMetadata)
	r.Get("/objects/{id}/metadata", s.HandleGetMetadata)
	r.Put("/objects/{id}/metadata", s.HandleSetMetadata)

	return r
}

// TestHandlersIntegration tests the full request/response cycle for all handlers.
func TestHandlersIntegration(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	userID := "test-handler-user-" + uuid.New().String()[:8]

	// Create test user
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Failed to acquire connection: %v", err)
	}
	_, err = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Handler Test User', $2)
		ON CONFLICT (id) DO NOTHING
	`, userID, userID+"@test.com")
	conn.Release()
	if err != nil {
		t.Fatalf("Failed to create test user: %v", err)
	}

	// Cleanup
	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM cortex.object WHERE user_id = $1`, userID)
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id = $1`, userID)
	}()

	s, mockStorage := integrationTestService(t, pool)
	router := testRouter(s, userID, pool, mockStorage)

	var createdObjectID string

	t.Run("Upload", func(t *testing.T) {
		body := []byte("test file content for upload")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("Upload failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var resp map[string]string
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		createdObjectID = resp["id"]
		if createdObjectID == "" {
			t.Fatal("Upload response missing 'id'")
		}

		// Verify object was stored in mock storage
		parsedID := uuid.MustParse(createdObjectID)
		if _, ok := mockStorage.objects[parsedID]; !ok {
			t.Error("Object not found in mock storage after upload")
		}
	})

	t.Run("StreamingUpload", func(t *testing.T) {
		body := []byte("streaming file content")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/octet-stream")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("Streaming upload failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var resp map[string]string
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		streamID := resp["id"]
		if streamID == "" {
			t.Fatal("Streaming upload response missing 'id'")
		}

		// Verify object was stored in mock storage with correct content
		parsedID := uuid.MustParse(streamID)
		stored, ok := mockStorage.objects[parsedID]
		if !ok {
			t.Fatal("Object not found in mock storage after streaming upload")
		}
		if string(stored) != "streaming file content" {
			t.Errorf("Stored content mismatch: got %q", string(stored))
		}
	})

	t.Run("StreamingUpload_ContentSize", func(t *testing.T) {
		// Upload a known payload and verify content_size is persisted
		payload := []byte("content size verification payload")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/octet-stream")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("Streaming upload failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var resp map[string]string
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("Failed to acquire connection: %v", err)
		}
		defer conn.Release()

		var contentSize *int64
		err = conn.QueryRow(ctx,
			`SELECT content_size FROM cortex.object WHERE id = $1 AND user_id = $2`,
			resp["id"], userID).Scan(&contentSize)
		if err != nil {
			t.Fatalf("Failed to query content_size: %v", err)
		}
		if contentSize == nil {
			t.Error("content_size is NULL after streaming upload")
		} else if *contentSize != int64(len(payload)) {
			t.Errorf("content_size = %d, want %d", *contentSize, len(payload))
		}
	})

	t.Run("StreamingUpload_StorageFailure", func(t *testing.T) {
		// Use a failing mock to test orphan cleanup
		failMock := newMockStorage()
		failMock.uploadErr = errors.New("GCS unavailable")
		failRouter := testRouter(s, userID, pool, failMock)

		body := []byte("will fail")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/octet-stream")
		rec := httptest.NewRecorder()

		failRouter.ServeHTTP(rec, req)

		if rec.Code != http.StatusInternalServerError {
			t.Errorf("Expected 500 for storage failure, got %d", rec.Code)
		}

		// Verify orphaned DB record was cleaned up
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("Failed to acquire connection: %v", err)
		}
		defer conn.Release()

		var orphanCount int
		err = conn.QueryRow(ctx,
			`SELECT COUNT(*) FROM cortex.object WHERE user_id = $1 AND content_size IS NULL`,
			userID).Scan(&orphanCount)
		if err != nil {
			t.Fatalf("Failed to query orphaned records: %v", err)
		}
		if orphanCount != 0 {
			t.Errorf("Found %d orphaned DB records with NULL content_size", orphanCount)
		}
	})

	t.Run("StreamingUpload_SemaphoreRejection", func(t *testing.T) {
		// Create a service with semaphore capacity of 0 (always full)
		busyService := &Service{
			Logger:    s.Logger,
			config:    s.config,
			pool:      pool,
			uploadSem: make(chan struct{}, 1),
		}
		// Fill the semaphore
		busyService.uploadSem <- struct{}{}

		busyRouter := testRouter(busyService, userID, pool, mockStorage)

		body := []byte("should be rejected")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/octet-stream")
		rec := httptest.NewRecorder()

		busyRouter.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("Expected 503 for semaphore rejection, got %d", rec.Code)
		}

		// Drain semaphore
		<-busyService.uploadSem
	})

	t.Run("StreamingUpload_MidStreamFailure", func(t *testing.T) {
		// Mock fails after reading 5 bytes (simulates GCS io.Copy failure mid-stream)
		failMock := newMockStorage()
		failMock.uploadFailAfter = 5
		failRouter := testRouter(s, userID, pool, failMock)

		body := []byte("this payload is longer than 5 bytes")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/octet-stream")
		rec := httptest.NewRecorder()

		failRouter.ServeHTTP(rec, req)

		if rec.Code != http.StatusInternalServerError {
			t.Errorf("Expected 500 for mid-stream failure, got %d", rec.Code)
		}

		// Verify orphaned DB record was cleaned up (same as StorageFailure test)
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("Failed to acquire connection: %v", err)
		}
		defer conn.Release()

		var orphanCount int
		err = conn.QueryRow(ctx,
			`SELECT COUNT(*) FROM cortex.object WHERE user_id = $1 AND content_size IS NULL`,
			userID).Scan(&orphanCount)
		if err != nil {
			t.Fatalf("Failed to query orphaned records: %v", err)
		}
		if orphanCount != 0 {
			t.Errorf("Found %d orphaned DB records after mid-stream failure", orphanCount)
		}
	})

	// NOTE: UpdateContentSize failure path (non-fatal, returns 201 with NULL size) is not
	// tested here because it requires injecting a DB-level failure after a successful upload.
	// The current integration test setup uses a real Postgres connection, and there's no
	// clean way to make only UpdateContentSize fail without a DB mock layer. The code path
	// is a simple log + continue (upload.go:168-171), so the risk is low.

	t.Run("List", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("List failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var objects []ObjectResponse
		if err := json.NewDecoder(rec.Body).Decode(&objects); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		found := false
		for _, obj := range objects {
			if obj.ID == createdObjectID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Created object %s not found in list of %d objects", createdObjectID, len(objects))
		}
	})

	t.Run("Download", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects/"+createdObjectID, nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("Download failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		content := rec.Body.String()
		if content != "test file content for upload" {
			t.Errorf("Downloaded content mismatch: got %q", content)
		}
	})

	t.Run("SetMetadata_POST", func(t *testing.T) {
		metadata := `{"workspace_id": "ws-123", "chat_id": "chat-456"}`
		req := httptest.NewRequest(http.MethodPost, "/objects/"+createdObjectID+"/metadata", bytes.NewReader([]byte(metadata)))
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("SetMetadata failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("GetMetadata", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects/"+createdObjectID+"/metadata", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("GetMetadata failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var resp ObjectResponse
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		var metadata map[string]string
		if err := json.Unmarshal(resp.Metadata, &metadata); err != nil {
			t.Fatalf("Failed to unmarshal metadata: %v", err)
		}

		if metadata["workspace_id"] != "ws-123" {
			t.Errorf("workspace_id mismatch: got %q, want %q", metadata["workspace_id"], "ws-123")
		}
		if metadata["chat_id"] != "chat-456" {
			t.Errorf("chat_id mismatch: got %q, want %q", metadata["chat_id"], "chat-456")
		}
	})

	t.Run("SetMetadata_PUT", func(t *testing.T) {
		metadata := `{"workspace_id": "ws-789"}`
		req := httptest.NewRequest(http.MethodPut, "/objects/"+createdObjectID+"/metadata", bytes.NewReader([]byte(metadata)))
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("SetMetadata PUT failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("Update", func(t *testing.T) {
		newContent := []byte("updated file content")
		req := httptest.NewRequest(http.MethodPut, "/objects/"+createdObjectID, bytes.NewReader(newContent))
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("Update failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		// Verify content was updated in mock storage
		parsedID := uuid.MustParse(createdObjectID)
		stored := mockStorage.objects[parsedID]
		if string(stored) != "updated file content" {
			t.Errorf("Stored content mismatch: got %q", string(stored))
		}
	})

	t.Run("Delete", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/objects/"+createdObjectID, nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("Delete failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("List_AfterDelete", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("List failed: status=%d, body=%s", rec.Code, rec.Body.String())
		}

		var objects []ObjectResponse
		if err := json.NewDecoder(rec.Body).Decode(&objects); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}

		for _, obj := range objects {
			if obj.ID == createdObjectID {
				t.Errorf("Deleted object %s still appears in list", createdObjectID)
			}
		}
	})

	t.Run("Download_NotFound", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects/"+createdObjectID, nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("Expected 404 for deleted object, got %d", rec.Code)
		}
	})
}

// TestHandlersValidation tests input validation in handlers.
func TestHandlersValidation(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	userID := "test-validation-user-" + uuid.New().String()[:8]

	// Create test user
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Validation Test User', $2)
		ON CONFLICT (id) DO NOTHING
	`, userID, userID+"@test.com")
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM cortex.object WHERE user_id = $1`, userID)
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id = $1`, userID)
	}()

	s, mockStorage := integrationTestService(t, pool)
	router := testRouter(s, userID, pool, mockStorage)

	t.Run("Download_InvalidID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects/not-a-uuid", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("Expected 400 for invalid UUID, got %d", rec.Code)
		}
	})

	t.Run("Download_NonexistentID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects/"+uuid.New().String(), nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("Expected 404 for nonexistent object, got %d", rec.Code)
		}
	})

	t.Run("SetMetadata_InvalidJSON", func(t *testing.T) {
		// First create an object
		body := []byte("test content")
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var resp map[string]string
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		objectID := resp["id"]

		// Try to set invalid JSON metadata
		req = httptest.NewRequest(http.MethodPost, "/objects/"+objectID+"/metadata", bytes.NewReader([]byte("not json")))
		rec = httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("Expected 400 for invalid JSON, got %d", rec.Code)
		}
	})

	t.Run("Delete_InvalidID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/objects/not-a-uuid", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("Expected 400 for invalid UUID, got %d", rec.Code)
		}
	})
}

// TestListFiltering tests the workspace_id and chat_id query params.
func TestListFiltering(t *testing.T) {
	connStr := os.Getenv("POSTGRES_CONNECTION")
	if connStr == "" {
		t.Skip("Skipping integration test: POSTGRES_CONNECTION not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	userID := "test-filter-user-" + uuid.New().String()[:8]

	// Create test user
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, `
		INSERT INTO public."user" (id, full_name, email)
		VALUES ($1, 'Filter Test User', $2)
		ON CONFLICT (id) DO NOTHING
	`, userID, userID+"@test.com")
	conn.Release()

	defer func() {
		conn, _ := pool.Acquire(ctx)
		defer conn.Release()
		_, _ = conn.Exec(ctx, `DELETE FROM cortex.object WHERE user_id = $1`, userID)
		_, _ = conn.Exec(ctx, `DELETE FROM public."user" WHERE id = $1`, userID)
	}()

	s, mockStorage := integrationTestService(t, pool)
	router := testRouter(s, userID, pool, mockStorage)

	// Create objects with different metadata
	createObject := func(metadata string) {
		req := httptest.NewRequest(http.MethodPost, "/objects", bytes.NewReader([]byte("content")))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		var resp map[string]string
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		objectID := resp["id"]

		// Set metadata
		req = httptest.NewRequest(http.MethodPost, "/objects/"+objectID+"/metadata", bytes.NewReader([]byte(metadata)))
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
	}

	createObject(`{"workspace_id": "ws-1", "chat_id": "chat-a"}`)
	createObject(`{"workspace_id": "ws-1", "chat_id": "chat-b"}`)
	createObject(`{"workspace_id": "ws-2", "chat_id": "chat-a"}`)

	t.Run("FilterByWorkspace", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects?workspace_id=ws-1", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		var objects []ObjectResponse
		_ = json.NewDecoder(rec.Body).Decode(&objects)

		if len(objects) != 2 {
			t.Errorf("Expected 2 objects for ws-1, got %d", len(objects))
		}
	})

	t.Run("FilterByChat", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects?chat_id=chat-a", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		var objects []ObjectResponse
		_ = json.NewDecoder(rec.Body).Decode(&objects)

		if len(objects) != 2 {
			t.Errorf("Expected 2 objects for chat-a, got %d", len(objects))
		}
	})

	t.Run("FilterByBoth", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/objects?workspace_id=ws-1&chat_id=chat-a", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		var objects []ObjectResponse
		_ = json.NewDecoder(rec.Body).Decode(&objects)

		if len(objects) != 1 {
			t.Errorf("Expected 1 object for ws-1+chat-a, got %d", len(objects))
		}
	})
}
