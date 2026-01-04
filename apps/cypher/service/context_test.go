package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUserIDContext(t *testing.T) {
	ctx := context.Background()

	// Empty context should return error
	_, err := UserIDFromContext(ctx)
	if err == nil {
		t.Error("UserIDFromContext() should return error for empty context")
	}

	// Context with user ID
	ctx = WithUserID(ctx, "user-123")
	userID, err := UserIDFromContext(ctx)
	if err != nil {
		t.Errorf("UserIDFromContext() error = %v", err)
	}
	if userID != "user-123" {
		t.Errorf("userID = %q, want %q", userID, "user-123")
	}
}

func TestUserIDContext_EmptyString(t *testing.T) {
	ctx := WithUserID(context.Background(), "")

	_, err := UserIDFromContext(ctx)
	if err == nil {
		t.Error("UserIDFromContext() should return error for empty user ID")
	}
}

func TestKeyCacheCtxMiddleware(t *testing.T) {
	// Create a mock cache (nil is fine for this test)
	var cache *KeyCache

	middleware := KeyCacheCtxMiddleware(cache)

	var extractedCache *KeyCache
	var extractErr error

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		extractedCache, extractErr = KeyCacheFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if extractErr != nil {
		t.Errorf("KeyCacheFromContext() error = %v", extractErr)
	}

	if extractedCache != cache {
		t.Error("extracted cache does not match original")
	}
}

func TestKeyCacheFromContext_Missing(t *testing.T) {
	ctx := context.Background()

	_, err := KeyCacheFromContext(ctx)
	if err == nil {
		t.Error("KeyCacheFromContext() should return error for empty context")
	}
}
