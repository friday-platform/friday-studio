package cypher

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNewClient_NoK8s(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// When not running in K8s, CA cert file doesn't exist
	client, err := NewClient(Config{
		Endpoint: "http://localhost:8085",
	}, logger)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.endpoint != "http://localhost:8085" {
		t.Errorf("expected endpoint http://localhost:8085, got %s", client.endpoint)
	}
}

func TestNewClient_DefaultTimeout(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	client, err := NewClient(Config{
		Endpoint: "http://localhost:8085",
	}, logger)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.timeout != defaultTimeout {
		t.Errorf("expected default timeout of %v, got %v", defaultTimeout, client.timeout)
	}
}

func TestEncrypt_Success(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create temp directory for mock K8s service account files
	tmpDir := t.TempDir()
	tokenPath := filepath.Join(tmpDir, "token")
	if err := os.WriteFile(tokenPath, []byte("test-sa-token"), 0o600); err != nil {
		t.Fatalf("failed to write token file: %v", err)
	}

	// Override the package variable for testing
	origTokenPath := k8sSATokenPath
	k8sSATokenPath = tokenPath
	t.Cleanup(func() {
		k8sSATokenPath = origTokenPath
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/encrypt" {
			t.Errorf("expected path /internal/encrypt, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}
		if r.Header.Get("Authorization") != "Bearer test-sa-token" {
			t.Errorf("expected Authorization Bearer test-sa-token, got %s", r.Header.Get("Authorization"))
		}

		var req EncryptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}
		if req.UserID != "user-123" {
			t.Errorf("expected user_id user-123, got %s", req.UserID)
		}
		if len(req.Plaintext) != 1 || req.Plaintext[0] != "secret-key" {
			t.Errorf("expected plaintext [secret-key], got %v", req.Plaintext)
		}

		resp := EncryptResponse{
			Ciphertext: [][]byte{[]byte("encrypted-data")},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client, err := NewClient(Config{
		Endpoint: server.URL,
	}, logger)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}

	ciphertexts, err := client.Encrypt(context.Background(), "user-123", []string{"secret-key"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ciphertexts) != 1 {
		t.Fatalf("expected 1 ciphertext, got %d", len(ciphertexts))
	}
	if string(ciphertexts[0]) != "encrypted-data" {
		t.Errorf("expected ciphertext 'encrypted-data', got %s", string(ciphertexts[0]))
	}
}

func TestEncrypt_ServerError(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Create temp token file
	tmpDir := t.TempDir()
	tokenPath := filepath.Join(tmpDir, "token")
	if err := os.WriteFile(tokenPath, []byte("test-sa-token"), 0o600); err != nil {
		t.Fatalf("failed to write token file: %v", err)
	}

	origTokenPath := k8sSATokenPath
	k8sSATokenPath = tokenPath
	t.Cleanup(func() {
		k8sSATokenPath = origTokenPath
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error": "internal error"}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{
		Endpoint: server.URL,
	}, logger)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}

	_, err = client.Encrypt(context.Background(), "user-123", []string{"secret-key"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestEncrypt_MissingToken(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Point to non-existent token file
	origTokenPath := k8sSATokenPath
	k8sSATokenPath = "/nonexistent/path/token"
	t.Cleanup(func() {
		k8sSATokenPath = origTokenPath
	})

	client, err := NewClient(Config{
		Endpoint: "http://localhost:8085",
	}, logger)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}

	_, err = client.Encrypt(context.Background(), "user-123", []string{"secret-key"})
	if err == nil {
		t.Fatal("expected error for missing token, got nil")
	}
}

func TestEncrypt_MultiplePlaintexts(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	tmpDir := t.TempDir()
	tokenPath := filepath.Join(tmpDir, "token")
	if err := os.WriteFile(tokenPath, []byte("test-sa-token"), 0o600); err != nil {
		t.Fatalf("failed to write token file: %v", err)
	}

	origTokenPath := k8sSATokenPath
	k8sSATokenPath = tokenPath
	t.Cleanup(func() {
		k8sSATokenPath = origTokenPath
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req EncryptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}

		// Return same number of ciphertexts as plaintexts
		ciphertexts := make([][]byte, len(req.Plaintext))
		for i, pt := range req.Plaintext {
			ciphertexts[i] = []byte("encrypted-" + pt)
		}

		resp := EncryptResponse{Ciphertext: ciphertexts}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client, err := NewClient(Config{
		Endpoint: server.URL,
	}, logger)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}

	ciphertexts, err := client.Encrypt(context.Background(), "user-123", []string{"key1", "key2", "key3"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ciphertexts) != 3 {
		t.Fatalf("expected 3 ciphertexts, got %d", len(ciphertexts))
	}
}

func TestEncryptRequest_JSON(t *testing.T) {
	req := EncryptRequest{
		UserID:    "user-123",
		Plaintext: []string{"secret1", "secret2"},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded EncryptRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.UserID != req.UserID {
		t.Errorf("expected user_id %s, got %s", req.UserID, decoded.UserID)
	}
	if len(decoded.Plaintext) != 2 {
		t.Errorf("expected 2 plaintext values, got %d", len(decoded.Plaintext))
	}
}

func TestEncryptResponse_JSON(t *testing.T) {
	resp := EncryptResponse{
		Ciphertext: [][]byte{[]byte("cipher1"), []byte("cipher2")},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded EncryptResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if len(decoded.Ciphertext) != 2 {
		t.Errorf("expected 2 ciphertext values, got %d", len(decoded.Ciphertext))
	}
}
