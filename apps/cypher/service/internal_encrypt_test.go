package service

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestK8sServiceAccountAuthMiddleware_MissingAuthHeader(t *testing.T) {
	handler := K8sServiceAccountAuthMiddleware(nil, AllowedInternalServiceAccounts)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("handler should not be called")
		}),
	)

	req := httptest.NewRequest("POST", "/internal/encrypt", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}
}

func TestK8sServiceAccountAuthMiddleware_InvalidAuthHeaderFormat(t *testing.T) {
	handler := K8sServiceAccountAuthMiddleware(nil, AllowedInternalServiceAccounts)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("handler should not be called")
		}),
	)

	req := httptest.NewRequest("POST", "/internal/encrypt", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz") // Basic auth, not Bearer
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}
}

func TestK8sServiceAccountAuthMiddleware_EmptyBearerToken(t *testing.T) {
	handler := K8sServiceAccountAuthMiddleware(nil, AllowedInternalServiceAccounts)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("handler should not be called")
		}),
	)

	req := httptest.NewRequest("POST", "/internal/encrypt", nil)
	req.Header.Set("Authorization", "Bearer ")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}
}
