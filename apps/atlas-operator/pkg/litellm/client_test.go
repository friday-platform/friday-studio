package litellm

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func mustNewClient(t *testing.T, cfg Config) *Client {
	t.Helper()
	c, err := NewClient(cfg, slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError})))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func TestNewClient(t *testing.T) {
	client := mustNewClient(t, Config{
		Endpoint:  "http://localhost:4000",
		MasterKey: "sk-test-key",
	})

	if client.endpoint != "http://localhost:4000" {
		t.Errorf("expected endpoint http://localhost:4000, got %s", client.endpoint)
	}
	if client.masterKey != "sk-test-key" {
		t.Errorf("expected masterKey sk-test-key, got %s", client.masterKey)
	}
}

func TestNewClient_InvalidEndpoint(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	_, err := NewClient(Config{Endpoint: "://bad", MasterKey: "key"}, logger)
	if err == nil {
		t.Fatal("expected error for invalid endpoint")
	}
}

func TestNewClient_DefaultTimeout(t *testing.T) {
	client := mustNewClient(t, Config{
		Endpoint:  "http://localhost:4000",
		MasterKey: "sk-test-key",
	})

	if client.timeout != defaultTimeout {
		t.Errorf("expected default timeout of %v, got %v", defaultTimeout, client.timeout)
	}
}

func TestCreateVirtualKey_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/key/generate" {
			t.Errorf("expected path /key/generate, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer sk-master-key" {
			t.Errorf("expected Authorization header, got %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}

		var req CreateVirtualKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}
		if req.UserID != "user-123" {
			t.Errorf("expected user_id user-123, got %s", req.UserID)
		}
		if req.KeyAlias != "atlas-user-123" {
			t.Errorf("expected key_alias atlas-user-123, got %s", req.KeyAlias)
		}

		resp := CreateVirtualKeyResponse{
			Key:    "sk-generated-key-abc123",
			UserID: req.UserID,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := mustNewClient(t, Config{
		Endpoint:  server.URL,
		MasterKey: "sk-master-key",
	})

	resp, err := client.CreateVirtualKey(context.Background(), CreateVirtualKeyRequest{
		UserID:         "user-123",
		KeyAlias:       "atlas-user-123",
		MaxBudget:      Float64Ptr(200.0),
		BudgetDuration: "30d",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Key != "sk-generated-key-abc123" {
		t.Errorf("expected key sk-generated-key-abc123, got %s", resp.Key)
	}
	if resp.UserID != "user-123" {
		t.Errorf("expected user_id user-123, got %s", resp.UserID)
	}
}

func TestCreateVirtualKey_Error(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error": "invalid request"}`))
	}))
	defer server.Close()

	client := mustNewClient(t, Config{
		Endpoint:  server.URL,
		MasterKey: "sk-master-key",
	})

	_, err := client.CreateVirtualKey(context.Background(), CreateVirtualKeyRequest{
		UserID: "user-123",
	})

	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestDeleteVirtualKeyByUserID_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/key/delete" {
			t.Errorf("expected path /key/delete, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var req deleteVirtualKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}
		if len(req.KeyAliases) != 1 || req.KeyAliases[0] != "atlas-user-456" {
			t.Errorf("expected key_aliases [atlas-user-456], got %v", req.KeyAliases)
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"deleted": true}`))
	}))
	defer server.Close()

	client := mustNewClient(t, Config{
		Endpoint:  server.URL,
		MasterKey: "sk-master-key",
	})

	err := client.DeleteVirtualKeyByUserID(context.Background(), "user-456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteVirtualKeyByUserID_Error(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error": "key not found"}`))
	}))
	defer server.Close()

	client := mustNewClient(t, Config{
		Endpoint:  server.URL,
		MasterKey: "sk-master-key",
	})

	err := client.DeleteVirtualKeyByUserID(context.Background(), "user-456")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestKeyAliasForUser(t *testing.T) {
	tests := []struct {
		userID   string
		expected string
	}{
		{"user-123", "atlas-user-123"},
		{"abc", "atlas-abc"},
		{"", "atlas-"},
	}

	for _, tt := range tests {
		result := KeyAliasForUser(tt.userID)
		if result != tt.expected {
			t.Errorf("KeyAliasForUser(%q) = %q, want %q", tt.userID, result, tt.expected)
		}
	}
}

func TestHasKey_Exists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/key/list" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("user_id") != "user-1" {
			t.Errorf("unexpected user_id: %s", r.URL.Query().Get("user_id"))
		}
		if r.URL.Query().Get("page_size") != "1" {
			t.Errorf("unexpected page_size: %s", r.URL.Query().Get("page_size"))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"keys": [{"token": "sk-123"}], "total_count": 1}`))
	}))
	defer srv.Close()

	c := mustNewClient(t, Config{Endpoint: srv.URL, MasterKey: "test-key"})

	got, err := c.HasKey(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Error("expected true, got false")
	}
}

func TestHasKey_NotExists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"keys": [], "total_count": 0}`))
	}))
	defer srv.Close()

	c := mustNewClient(t, Config{Endpoint: srv.URL, MasterKey: "test-key"})

	got, err := c.HasKey(context.Background(), "user-missing")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got {
		t.Error("expected false, got true")
	}
}

func TestHasKey_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`internal error`))
	}))
	defer srv.Close()

	c := mustNewClient(t, Config{Endpoint: srv.URL, MasterKey: "test-key"})

	_, err := c.HasKey(context.Background(), "user-1")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestFloat64Ptr(t *testing.T) {
	val := 123.45
	ptr := Float64Ptr(val)
	if ptr == nil {
		t.Fatal("expected non-nil pointer")
	}
	if *ptr != val {
		t.Errorf("expected %f, got %f", val, *ptr)
	}
}
