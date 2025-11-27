package extractuserid_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tempestteam/traefik/extractuserid"
)

func generateRSAKeyPair(t *testing.T) (privateKey *rsa.PrivateKey, publicKeyPEM string) {
	t.Helper()

	// Generate private key
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	// Convert public key to PEM format
	publicKeyBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyBlock := &pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: publicKeyBytes,
	}
	publicKeyPEM = string(pem.EncodeToMemory(publicKeyBlock))

	return key, publicKeyPEM
}

func TestExtractUserID(t *testing.T) {
	testUserID := "xL4gEWMNg9Pve"

	validClaims := jwt.MapClaims{
		"sub": testUserID,
		"exp": time.Now().Add(2 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
		"nbf": time.Now().Unix(),
	}

	expiredClaims := jwt.MapClaims{
		"sub": testUserID,
		"exp": time.Now().Add(-2 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
		"nbf": time.Now().Unix(),
	}

	noSubClaims := jwt.MapClaims{
		"exp": time.Now().Add(2 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
		"nbf": time.Now().Unix(),
	}

	privateKey, publicKeyPEM := generateRSAKeyPair(t)

	jwtFile, err := os.CreateTemp("", "test_jwt_public_key")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(jwtFile.Name())
	defer jwtFile.Close()

	if _, err := jwtFile.Write([]byte(publicKeyPEM)); err != nil {
		t.Fatal(err)
	}

	_, invalidPublicKeyPEM := generateRSAKeyPair(t)
	invalidJWTFile, err := os.CreateTemp("", "test_invalid_jwt_public_key")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(invalidJWTFile.Name())
	defer invalidJWTFile.Close()

	if _, err := invalidJWTFile.Write([]byte(invalidPublicKeyPEM)); err != nil {
		t.Fatal(err)
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, validClaims)
	validToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	token = jwt.NewWithClaims(jwt.SigningMethodRS256, expiredClaims)
	expiredToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	token = jwt.NewWithClaims(jwt.SigningMethodRS256, noSubClaims)
	noSubToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	testCases := []struct {
		name              string
		cookieName        string
		cookieValue       string
		preExistingHeader string
		JWTPublicKey      string
		responseCode      int
		expectedHeader    string
	}{
		{
			name:           "valid JWT token in cookie",
			cookieName:     "tempest_token",
			cookieValue:    validToken,
			JWTPublicKey:   jwtFile.Name(),
			responseCode:   http.StatusOK,
			expectedHeader: testUserID,
		},
		{
			name:              "malicious pre-existing header is replaced",
			cookieName:        "tempest_token",
			cookieValue:       validToken,
			preExistingHeader: "deadbeef",
			JWTPublicKey:      jwtFile.Name(),
			responseCode:      http.StatusOK,
			expectedHeader:    testUserID,
		},
		{
			name:           "expired JWT token in cookie - permissive",
			cookieName:     "tempest_token",
			cookieValue:    expiredToken,
			JWTPublicKey:   jwtFile.Name(),
			responseCode:   http.StatusOK,
			expectedHeader: "",
		},
		{
			name:           "invalid JWT secret key - permissive",
			cookieName:     "tempest_token",
			cookieValue:    validToken,
			JWTPublicKey:   invalidJWTFile.Name(),
			responseCode:   http.StatusOK,
			expectedHeader: "",
		},
		{
			name:           "missing sub claim - permissive",
			cookieName:     "tempest_token",
			cookieValue:    noSubToken,
			JWTPublicKey:   jwtFile.Name(),
			responseCode:   http.StatusOK,
			expectedHeader: "",
		},
		{
			name:           "no cookie - permissive",
			cookieName:     "wrong_cookie_name",
			cookieValue:    validToken,
			JWTPublicKey:   jwtFile.Name(),
			responseCode:   http.StatusOK,
			expectedHeader: "",
		},
		{
			name:              "header injection without valid JWT blocked",
			cookieName:        "wrong_cookie_name",
			cookieValue:       validToken,
			preExistingHeader: "784c346745574d4e6739507665",
			JWTPublicKey:      jwtFile.Name(),
			responseCode:      http.StatusOK,
			expectedHeader:    "",
		},
		{
			name:              "header injection with invalid JWT blocked",
			cookieName:        "tempest_token",
			cookieValue:       expiredToken,
			preExistingHeader: "784c346745574d4e6739507665",
			JWTPublicKey:      jwtFile.Name(),
			responseCode:      http.StatusOK,
			expectedHeader:    "",
		},
	}

	ctx := context.Background()
	next := http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {})

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := extractuserid.CreateConfig()
			cfg.CookieName = "tempest_token"
			cfg.JWTPublicKey = tc.JWTPublicKey
			cfg.HeaderName = "X-Atlas-User-ID"

			handler, err := extractuserid.New(ctx, next, cfg, "extractuserid-plugin")
			if err != nil {
				t.Fatal(err)
			}

			recorder := httptest.NewRecorder()

			req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost", nil)
			if err != nil {
				t.Fatal(err)
			}

			req.AddCookie(&http.Cookie{
				Name:  tc.cookieName,
				Value: tc.cookieValue,
			})
			if tc.preExistingHeader != "" {
				req.Header.Add("X-Atlas-User-ID", tc.preExistingHeader)
			}

			handler.ServeHTTP(recorder, req)

			if recorder.Result().StatusCode != tc.responseCode {
				t.Errorf("invalid response code: got %d, want %d", recorder.Result().StatusCode, tc.responseCode)
			}

			header := req.Header.Get("X-Atlas-User-ID")
			if header != tc.expectedHeader {
				t.Errorf("got unexpected header: got %s, want %s", header, tc.expectedHeader)
			}
		})
	}
}
