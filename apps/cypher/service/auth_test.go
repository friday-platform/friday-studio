package service

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// createTestJWT creates a minimal JWT for testing (no signature verification).
func createTestJWT(claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))

	claimsJSON, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(claimsJSON)

	return header + "." + payload + "."
}

func TestJWTAuthMiddleware_MissingHeader(t *testing.T) {
	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTAuthMiddleware_InvalidFormat(t *testing.T) {
	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "InvalidFormat")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTAuthMiddleware_MissingUserMetadata(t *testing.T) {
	token := createTestJWT(map[string]any{
		"sub": "user-123",
	})

	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTAuthMiddleware_MissingTempestUserID(t *testing.T) {
	token := createTestJWT(map[string]any{
		"sub": "user-123",
		"user_metadata": map[string]any{
			"name": "Test User",
		},
	})

	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTAuthMiddleware_ValidToken(t *testing.T) {
	token := createTestJWT(map[string]any{
		"sub": "supabase-user-id",
		"user_metadata": map[string]any{
			"tempest_user_id": "user-abc123",
		},
	})

	var extractedUserID string
	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, err := UserIDFromContext(r.Context())
		if err != nil {
			t.Errorf("UserIDFromContext() error = %v", err)
			return
		}
		extractedUserID = userID
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	if extractedUserID != "user-abc123" {
		t.Errorf("userID = %q, want %q", extractedUserID, "user-abc123")
	}
}

func TestJWTAuthMiddleware_BearerCaseInsensitive(t *testing.T) {
	token := createTestJWT(map[string]any{
		"user_metadata": map[string]any{
			"tempest_user_id": "user-123",
		},
	})

	handler := JWTAuthMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	testCases := []string{"Bearer", "bearer", "BEARER", "BeArEr"}
	for _, prefix := range testCases {
		req := httptest.NewRequest("GET", "/", nil)
		req.Header.Set("Authorization", prefix+" "+token)
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("prefix %q: status = %d, want %d", prefix, w.Code, http.StatusOK)
		}
	}
}
