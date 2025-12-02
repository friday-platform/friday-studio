package atlaskey

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestNew(t *testing.T) {
	// Create a valid public key file for tests that need it
	_, publicKey := createTestKeys(t)
	validKeyPath := writeTestPublicKey(t, publicKey)

	tests := []struct {
		name        string
		config      *Config
		expectError bool
	}{
		{
			name: "valid config",
			config: &Config{
				JWTPublicKey: validKeyPath,
				HeaderName:   "X-Atlas-User-Email",
				Issuer:       "tempest-atlas",
				Audience:     "atlas",
			},
			expectError: false,
		},
		{
			name: "missing public key path",
			config: &Config{
				HeaderName: "X-Atlas-User-Email",
				Issuer:     "tempest-atlas",
				Audience:   "atlas",
			},
			expectError: true,
		},
		{
			name: "invalid public key path",
			config: &Config{
				JWTPublicKey: "/nonexistent/path/to/key",
				HeaderName:   "X-Atlas-User-Email",
				Issuer:       "tempest-atlas",
				Audience:     "atlas",
			},
			expectError: true,
		},
		{
			name: "missing header name",
			config: &Config{
				JWTPublicKey: validKeyPath,
				Issuer:       "tempest-atlas",
				Audience:     "atlas",
			},
			expectError: true,
		},
		{
			name: "missing issuer",
			config: &Config{
				JWTPublicKey: validKeyPath,
				HeaderName:   "X-Atlas-User-Email",
				Audience:     "atlas",
			},
			expectError: true,
		},
		{
			name: "missing audience",
			config: &Config{
				JWTPublicKey: validKeyPath,
				HeaderName:   "X-Atlas-User-Email",
				Issuer:       "tempest-atlas",
			},
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
			_, err := New(context.Background(), next, tt.config, "test")
			if tt.expectError && err == nil {
				t.Error("expected error but got nil")
			}
			if !tt.expectError && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestServeHTTP(t *testing.T) {
	// Generate test keys
	privateKey, publicKey := createTestKeys(t)
	publicKeyPath := writeTestPublicKey(t, publicKey)

	tests := []struct {
		name           string
		authHeader     string
		expectedStatus int
		expectedEmail  string
	}{
		{
			name:           "missing authorization header",
			authHeader:     "",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "invalid authorization format",
			authHeader:     "Basic abc123",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "invalid token",
			authHeader:     "Bearer invalid.token.here",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "valid token",
			authHeader:     "Bearer " + createTestToken(t, privateKey, "test@tempest.team", "tempest-atlas", []string{"atlas"}, time.Now().Add(time.Hour)),
			expectedStatus: http.StatusOK,
			expectedEmail:  "test@tempest.team",
		},
		{
			name:           "wrong issuer",
			authHeader:     "Bearer " + createTestToken(t, privateKey, "test@tempest.team", "wrong-issuer", []string{"atlas"}, time.Now().Add(time.Hour)),
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "wrong audience",
			authHeader:     "Bearer " + createTestToken(t, privateKey, "test@tempest.team", "tempest-atlas", []string{"wrong-audience"}, time.Now().Add(time.Hour)),
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "expired token",
			authHeader:     "Bearer " + createTestToken(t, privateKey, "test@tempest.team", "tempest-atlas", []string{"atlas"}, time.Now().Add(-time.Hour)),
			expectedStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var capturedEmail string
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				capturedEmail = r.Header.Get("X-Atlas-User-Email")
				w.WriteHeader(http.StatusOK)
			})

			config := &Config{
				JWTPublicKey: publicKeyPath,
				HeaderName:   "X-Atlas-User-Email",
				Issuer:       "tempest-atlas",
				Audience:     "atlas",
			}

			handler, err := New(context.Background(), next, config, "test")
			if err != nil {
				t.Fatalf("failed to create handler: %v", err)
			}

			req := httptest.NewRequest(http.MethodPost, "/space", nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}

			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, rr.Code)
			}

			if tt.expectedEmail != "" && capturedEmail != tt.expectedEmail {
				t.Errorf("expected email %s, got %s", tt.expectedEmail, capturedEmail)
			}
		})
	}
}

func TestHeaderInjectionPrevention(t *testing.T) {
	privateKey, publicKey := createTestKeys(t)
	publicKeyPath := writeTestPublicKey(t, publicKey)

	var capturedEmail string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedEmail = r.Header.Get("X-Atlas-User-Email")
		w.WriteHeader(http.StatusOK)
	})

	config := &Config{
		JWTPublicKey: publicKeyPath,
		HeaderName:   "X-Atlas-User-Email",
		Issuer:       "tempest-atlas",
		Audience:     "atlas",
	}

	handler, err := New(context.Background(), next, config, "test")
	if err != nil {
		t.Fatalf("failed to create handler: %v", err)
	}

	// Create request with pre-existing header (injection attempt)
	req := httptest.NewRequest(http.MethodPost, "/space", nil)
	req.Header.Set("X-Atlas-User-Email", "injected@evil.com")
	req.Header.Set("Authorization", "Bearer "+createTestToken(t, privateKey, "legit@tempest.team", "tempest-atlas", []string{"atlas"}, time.Now().Add(time.Hour)))

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rr.Code)
	}

	// The captured email should be from the token, not the injected value
	if capturedEmail != "legit@tempest.team" {
		t.Errorf("expected email legit@tempest.team, got %s (header injection not prevented)", capturedEmail)
	}
}

func createTestKeys(t *testing.T) (*rsa.PrivateKey, *rsa.PublicKey) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	return privateKey, &privateKey.PublicKey
}

func writeTestPublicKey(t *testing.T, publicKey *rsa.PublicKey) string {
	t.Helper()
	pubKeyBytes, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatalf("failed to marshal public key: %v", err)
	}

	pubKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubKeyBytes,
	})

	tmpFile := filepath.Join(t.TempDir(), "public.pem")
	if err := os.WriteFile(tmpFile, pubKeyPEM, 0o600); err != nil {
		t.Fatalf("failed to write public key: %v", err)
	}

	return tmpFile
}

func createTestToken(t *testing.T, privateKey *rsa.PrivateKey, email, issuer string, audience []string, exp time.Time) string {
	t.Helper()
	claims := jwt.MapClaims{
		"email": email,
		"iss":   issuer,
		"sub":   email,
		"aud":   audience,
		"exp":   exp.Unix(),
		"iat":   time.Now().Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tokenString, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}

	return tokenString
}
