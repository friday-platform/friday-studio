package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDBCtxMiddleware(t *testing.T) {
	// We can't create a real pool without a database, but we can test the middleware pattern
	var capturedPool *pgxpool.Pool

	handler := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		pool, err := DBFromContext(r.Context())
		if err != nil {
			t.Errorf("DBFromContext failed: %v", err)
			return
		}
		capturedPool = pool
	})

	// Create a nil pool for testing (just testing the middleware passes it through)
	var testPool *pgxpool.Pool

	middleware := DBCtxMiddleware(testPool)
	wrappedHandler := middleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	wrappedHandler.ServeHTTP(rec, req)

	if capturedPool != testPool {
		t.Error("DBCtxMiddleware did not properly inject pool into context")
	}
}

func TestDBFromContext_Missing(t *testing.T) {
	ctx := context.Background()
	_, err := DBFromContext(ctx)
	if err == nil {
		t.Error("DBFromContext should return error when pool not in context")
	}
}

func TestStorageCtxMiddleware(t *testing.T) {
	var capturedStorage Storage

	handler := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		storage, err := StorageFromContext(r.Context())
		if err != nil {
			t.Errorf("StorageFromContext failed: %v", err)
			return
		}
		capturedStorage = storage
	})

	// Create a nil storage for testing (StorageClient implements Storage)
	var testStorage *StorageClient

	middleware := StorageCtxMiddleware(testStorage)
	wrappedHandler := middleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	wrappedHandler.ServeHTTP(rec, req)

	if capturedStorage != testStorage {
		t.Error("StorageCtxMiddleware did not properly inject storage into context")
	}
}

func TestStorageFromContext_Missing(t *testing.T) {
	ctx := context.Background()
	_, err := StorageFromContext(ctx)
	if err == nil {
		t.Error("StorageFromContext should return error when storage not in context")
	}
}

func TestMiddlewareChaining(t *testing.T) {
	// Test that both middlewares can be chained together
	var gotDB, gotStorage bool

	handler := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, err := DBFromContext(r.Context())
		gotDB = err == nil

		_, err = StorageFromContext(r.Context())
		gotStorage = err == nil
	})

	// Chain middlewares
	var testPool *pgxpool.Pool
	var testStorage Storage = (*StorageClient)(nil)

	wrapped := DBCtxMiddleware(testPool)(StorageCtxMiddleware(testStorage)(handler))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	wrapped.ServeHTTP(rec, req)

	if !gotDB {
		t.Error("DB should be available in chained middleware context")
	}
	if !gotStorage {
		t.Error("Storage should be available in chained middleware context")
	}
}
