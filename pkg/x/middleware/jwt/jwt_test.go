package jwt

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestWithUserID(t *testing.T) {
	ctx := context.Background()
	userID := "user-123"

	ctx = WithUserID(ctx, userID)

	got, err := MustGetUserID(ctx)
	if err != nil {
		t.Fatalf("MustGetUserID() error = %v", err)
	}
	if got != userID {
		t.Errorf("MustGetUserID() = %q, want %q", got, userID)
	}
}

func TestMustGetUserID_Missing(t *testing.T) {
	ctx := context.Background()

	_, err := MustGetUserID(ctx)
	if !errors.Is(err, ErrMissingUserID) {
		t.Errorf("MustGetUserID() error = %v, want %v", err, ErrMissingUserID)
	}
}

func TestMustGetUserID_Empty(t *testing.T) {
	ctx := WithUserID(context.Background(), "")

	_, err := MustGetUserID(ctx)
	if !errors.Is(err, ErrMissingUserID) {
		t.Errorf("MustGetUserID() error = %v, want %v", err, ErrMissingUserID)
	}
}

func TestLoadRSAPublicKeyFromFile(t *testing.T) {
	// Generate test key pair
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}

	// Write public key to temp file
	tmpDir := t.TempDir()
	keyFile := filepath.Join(tmpDir, "public.pem")
	keyPEM := pemEncodeRSAPublicKey(privateKey)

	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		t.Fatalf("failed to write key file: %v", err)
	}

	// Test loading
	key, err := LoadRSAPublicKeyFromFile(keyFile)
	if err != nil {
		t.Fatalf("LoadRSAPublicKeyFromFile() error = %v", err)
	}
	if key == nil {
		t.Fatal("LoadRSAPublicKeyFromFile() returned nil key")
	}

	// Verify it matches original
	if key.N.Cmp(privateKey.N) != 0 {
		t.Error("loaded key does not match original")
	}
}

func TestLoadRSAPublicKeyFromFile_NotFound(t *testing.T) {
	_, err := LoadRSAPublicKeyFromFile("/nonexistent/path/key.pem")
	if err == nil {
		t.Error("LoadRSAPublicKeyFromFile() expected error for missing file")
	}
}

func TestAuthMiddleware_MissingHeader(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(nil, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddleware_InvalidHeaderFormat(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(nil, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	testCases := []string{
		"InvalidFormat",
		"Basic token123",
		"Bearer", // missing token
	}

	for _, header := range testCases {
		t.Run(header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("Authorization", header)
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
			}
		})
	}
}

func TestAuthMiddleware_ValidToken(t *testing.T) {
	// Generate test key pair
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}

	// Create valid token
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"user_metadata": map[string]any{
			"tempest_user_id": "user-456",
		},
	})
	tokenString, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(&privateKey.PublicKey, logger)

	var capturedUserID string
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, err := MustGetUserID(r.Context())
		if err != nil {
			t.Errorf("MustGetUserID() error = %v", err)
			return
		}
		capturedUserID = userID
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if capturedUserID != "user-456" {
		t.Errorf("userID = %q, want %q", capturedUserID, "user-456")
	}
}

func TestAuthMiddleware_InvalidSignature(t *testing.T) {
	// Generate two different key pairs
	privateKey1, _ := rsa.GenerateKey(rand.Reader, 2048)
	privateKey2, _ := rsa.GenerateKey(rand.Reader, 2048)

	// Sign with key1
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"user_metadata": map[string]any{
			"tempest_user_id": "user-789",
		},
	})
	tokenString, _ := token.SignedString(privateKey1)

	// Verify with key2 (should fail)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(&privateKey2.PublicKey, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddleware_MissingUserMetadata(t *testing.T) {
	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)

	// Token without user_metadata
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "some-subject",
	})
	tokenString, _ := token.SignedString(privateKey)

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(&privateKey.PublicKey, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddleware_MissingTempestUserID(t *testing.T) {
	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)

	// Token with user_metadata but no tempest_user_id
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"user_metadata": map[string]any{
			"other_field": "value",
		},
	})
	tokenString, _ := token.SignedString(privateKey)

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(&privateKey.PublicKey, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddleware_UnverifiedMode(t *testing.T) {
	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"user_metadata": map[string]any{
			"tempest_user_id": "user-unverified",
		},
	})
	tokenString, _ := token.SignedString(privateKey)

	// nil public key = unverified mode
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(nil, logger)

	var capturedUserID string
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, _ := MustGetUserID(r.Context())
		capturedUserID = userID
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if capturedUserID != "user-unverified" {
		t.Errorf("userID = %q, want %q", capturedUserID, "user-unverified")
	}
}

func TestAuthMiddleware_WrongSigningMethod(t *testing.T) {
	// Create HMAC-signed token (not RSA)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_metadata": map[string]any{
			"tempest_user_id": "user-hmac",
		},
	})
	tokenString, _ := token.SignedString([]byte("secret"))

	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	middleware := AuthMiddleware(&privateKey.PublicKey, logger)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenString)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

// pemEncodeRSAPublicKey encodes an RSA public key to PEM format.
func pemEncodeRSAPublicKey(key *rsa.PrivateKey) []byte {
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	b64 := base64.StdEncoding.EncodeToString(der)
	return []byte("-----BEGIN PUBLIC KEY-----\n" + b64 + "\n-----END PUBLIC KEY-----")
}
