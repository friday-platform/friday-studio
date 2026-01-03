package service

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleSendGridEmail(t *testing.T) {
	tests := []struct {
		name             string
		request          SendEmailRequest
		upstreamStatus   int
		upstreamBody     string
		wantStatus       int
		wantBodyContains string
	}{
		{
			name: "successful send",
			request: SendEmailRequest{
				To:      "test@example.com",
				From:    "sender@example.com",
				Subject: "Test Subject",
				Content: "Hello, World!",
			},
			upstreamStatus: http.StatusAccepted,
			upstreamBody:   `{"message": "success"}`,
			wantStatus:     http.StatusAccepted,
		},
		{
			name: "upstream error no retry",
			request: SendEmailRequest{
				To:      "test@example.com",
				From:    "sender@example.com",
				Subject: "Test Subject",
				Content: "Hello, World!",
			},
			upstreamStatus: http.StatusBadRequest,
			upstreamBody:   `{"error": "invalid request"}`,
			wantStatus:     http.StatusBadRequest,
		},
		{
			name:             "missing to field",
			request:          SendEmailRequest{From: "sender@example.com", Subject: "Test", Content: "Hello"},
			wantStatus:       http.StatusBadRequest,
			wantBodyContains: "missing required field: to",
		},
		{
			name:             "missing from field",
			request:          SendEmailRequest{To: "test@example.com", Subject: "Test", Content: "Hello"},
			wantStatus:       http.StatusBadRequest,
			wantBodyContains: "missing required field: from",
		},
		{
			name:             "missing subject field",
			request:          SendEmailRequest{To: "test@example.com", From: "sender@example.com", Content: "Hello"},
			wantStatus:       http.StatusBadRequest,
			wantBodyContains: "missing required field: subject",
		},
		{
			name:             "invalid to email format",
			request:          SendEmailRequest{To: "not-an-email", From: "sender@example.com", Subject: "Test", Content: "Hello"},
			wantStatus:       http.StatusBadRequest,
			wantBodyContains: "invalid email format: to",
		},
		{
			name:             "invalid from email format",
			request:          SendEmailRequest{To: "test@example.com", From: "not-an-email", Subject: "Test", Content: "Hello"},
			wantStatus:       http.StatusBadRequest,
			wantBodyContains: "invalid email format: from",
		},
		{
			name: "with template",
			request: SendEmailRequest{
				To:         "test@example.com",
				From:       "sender@example.com",
				Subject:    "Test Subject",
				TemplateID: "d-abc123",
				TemplateData: map[string]interface{}{
					"name": "John",
				},
			},
			upstreamStatus: http.StatusAccepted,
			upstreamBody:   `{"message": "success"}`,
			wantStatus:     http.StatusAccepted,
		},
		{
			name: "with custom headers",
			request: SendEmailRequest{
				To:      "test@example.com",
				From:    "sender@example.com",
				Subject: "Test Subject",
				Content: "Hello",
				CustomHeaders: map[string]string{
					"X-Atlas-User": "user@example.com",
				},
			},
			upstreamStatus: http.StatusAccepted,
			upstreamBody:   `{"message": "success"}`,
			wantStatus:     http.StatusAccepted,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var receivedAuth string
			var receivedBody []byte

			// Create mock SendGrid server
			mockSendGrid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				receivedAuth = r.Header.Get("Authorization")
				receivedBody, _ = io.ReadAll(r.Body)
				w.WriteHeader(tt.upstreamStatus)
				_, _ = w.Write([]byte(tt.upstreamBody))
			}))
			defer mockSendGrid.Close()

			// Override SendGrid host for testing
			origHost := sendGridHost
			sendGridHost = mockSendGrid.URL
			defer func() { sendGridHost = origHost }()

			svc := &Service{
				Logger: testLogger(),
				cfg: Config{
					SendGridAPIKey: "test-api-key",
				},
				client: &http.Client{},
			}

			body, _ := json.Marshal(tt.request)
			req := httptest.NewRequest(http.MethodPost, "/v1/sendgrid/send", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			svc.HandleSendGridEmail(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)

			if tt.wantBodyContains != "" {
				assert.Contains(t, rec.Body.String(), tt.wantBodyContains)
			}

			// For successful upstream calls, verify auth header was sent
			if tt.upstreamStatus != 0 && tt.wantBodyContains == "" {
				assert.Equal(t, "Bearer test-api-key", receivedAuth)
				assert.NotEmpty(t, receivedBody)
			}
		})
	}
}

func TestHandleSendGridEmail_Retry(t *testing.T) {
	// Use fast retry delays for testing
	origMinDelay, origMaxDelay := minRetryDelay, maxRetryDelay
	minRetryDelay, maxRetryDelay = 1*time.Millisecond, 5*time.Millisecond
	defer func() { minRetryDelay, maxRetryDelay = origMinDelay, origMaxDelay }()

	attempts := 0

	mockSendGrid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error": "temporarily unavailable"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"message": "success"}`))
	}))
	defer mockSendGrid.Close()

	origHost := sendGridHost
	sendGridHost = mockSendGrid.URL
	defer func() { sendGridHost = origHost }()

	svc := &Service{
		Logger: testLogger(),
		cfg:    Config{SendGridAPIKey: "test-key"},
		client: &http.Client{},
	}

	body, _ := json.Marshal(SendEmailRequest{
		To:      "test@example.com",
		From:    "sender@example.com",
		Subject: "Test",
		Content: "Hello",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/sendgrid/send", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	svc.HandleSendGridEmail(rec, req)

	assert.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, 3, attempts, "expected 3 attempts (2 retries + 1 success)")
}

func TestHandleParallelProxy(t *testing.T) {
	tests := []struct {
		name           string
		method         string
		path           string
		requestBody    string
		upstreamStatus int
		upstreamBody   string
		wantStatus     int
	}{
		{
			name:           "GET request proxied",
			method:         http.MethodGet,
			path:           "/v1/parallel/search",
			upstreamStatus: http.StatusOK,
			upstreamBody:   `{"results": []}`,
			wantStatus:     http.StatusOK,
		},
		{
			name:           "POST request proxied",
			method:         http.MethodPost,
			path:           "/v1/parallel/query",
			requestBody:    `{"query": "test"}`,
			upstreamStatus: http.StatusOK,
			upstreamBody:   `{"answer": "response"}`,
			wantStatus:     http.StatusOK,
		},
		{
			name:           "upstream error forwarded",
			method:         http.MethodGet,
			path:           "/v1/parallel/search",
			upstreamStatus: http.StatusNotFound,
			upstreamBody:   `{"error": "not found"}`,
			wantStatus:     http.StatusNotFound,
		},
		{
			name:           "query params preserved",
			method:         http.MethodGet,
			path:           "/v1/parallel/search?q=test&limit=10",
			upstreamStatus: http.StatusOK,
			upstreamBody:   `{"results": []}`,
			wantStatus:     http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var receivedPath string
			var receivedBody []byte
			var receivedAPIKey string

			// Create mock Parallel API server
			mockParallel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				receivedPath = r.URL.Path
				receivedAPIKey = r.Header.Get("x-api-key")
				receivedBody, _ = io.ReadAll(r.Body)

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.upstreamStatus)
				_, _ = w.Write([]byte(tt.upstreamBody))
			}))
			defer mockParallel.Close()

			// Create service that points to mock server
			svc := &Service{
				Logger: testLogger(),
				cfg: Config{
					ParallelAPIKey: "test-parallel-key",
				},
				client: &http.Client{},
			}

			// Override the parallel base URL for testing
			origURL := parallelBaseURL
			parallelBaseURL = mockParallel.URL
			defer func() { parallelBaseURL = origURL }()

			var body io.Reader
			if tt.requestBody != "" {
				body = bytes.NewReader([]byte(tt.requestBody))
			}

			req := httptest.NewRequest(tt.method, tt.path, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json")
			// Add a header that should be blocked
			req.Header.Set("Authorization", "Bearer should-be-blocked")

			rec := httptest.NewRecorder()

			svc.HandleParallelProxy(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			assert.Equal(t, tt.upstreamBody, rec.Body.String())

			// Verify API key was injected
			assert.Equal(t, "test-parallel-key", receivedAPIKey)

			// Verify path was correctly stripped
			expectedPath := tt.path
			if idx := bytes.IndexByte([]byte(tt.path), '?'); idx != -1 {
				expectedPath = tt.path[:idx]
			}
			expectedPath = expectedPath[len("/v1/parallel"):]
			assert.Equal(t, expectedPath, receivedPath)

			// Verify request body was forwarded
			if tt.requestBody != "" {
				assert.Equal(t, tt.requestBody, string(receivedBody))
			}
		})
	}
}

func TestHandleParallelProxy_HeaderFiltering(t *testing.T) {
	var receivedHeaders http.Header

	mockParallel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer mockParallel.Close()

	svc := &Service{
		Logger: testLogger(),
		cfg:    Config{ParallelAPIKey: "test-key"},
		client: &http.Client{},
	}

	origURL := parallelBaseURL
	parallelBaseURL = mockParallel.URL
	defer func() { parallelBaseURL = origURL }()

	req := httptest.NewRequest(http.MethodGet, "/v1/parallel/test", nil)
	// Headers that should be forwarded
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "test-agent")
	// Headers that should be blocked
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Cookie", "session=abc")
	req.Header.Set("X-Custom-Header", "should-block")

	rec := httptest.NewRecorder()
	svc.HandleParallelProxy(rec, req)

	// Verify allowed headers were forwarded
	assert.Equal(t, "application/json", receivedHeaders.Get("Content-Type"))
	assert.Equal(t, "application/json", receivedHeaders.Get("Accept"))
	assert.Equal(t, "test-agent", receivedHeaders.Get("User-Agent"))

	// Verify blocked headers were not forwarded
	assert.Empty(t, receivedHeaders.Get("Authorization"))
	assert.Empty(t, receivedHeaders.Get("Cookie"))
	assert.Empty(t, receivedHeaders.Get("X-Custom-Header"))

	// Verify API key was injected
	assert.Equal(t, "test-key", receivedHeaders.Get("x-api-key"))
}

func TestHandleParallelProxy_UpstreamFailure(t *testing.T) {
	svc := &Service{
		Logger: testLogger(),
		cfg:    Config{ParallelAPIKey: "test-key"},
		client: &http.Client{},
	}

	// Point to non-existent server
	origURL := parallelBaseURL
	parallelBaseURL = "http://localhost:99999"
	defer func() { parallelBaseURL = origURL }()

	req := httptest.NewRequest(http.MethodGet, "/v1/parallel/test", nil)
	rec := httptest.NewRecorder()

	svc.HandleParallelProxy(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), "proxy request failed")
}

func TestJWTAuthMiddleware(t *testing.T) {
	// Generate test RSA key pair
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	publicKeyPEM := exportRSAPublicKeyAsPEM(t, &privateKey.PublicKey)

	// Create a valid JWT token
	validToken := createTestJWT(t, privateKey, "tempest-atlas", []string{"atlas"}, time.Now().Add(time.Hour))

	// Create token with wrong issuer
	wrongIssuerToken := createTestJWT(t, privateKey, "wrong-issuer", []string{"atlas"}, time.Now().Add(time.Hour))

	// Create token with wrong audience
	wrongAudienceToken := createTestJWT(t, privateKey, "tempest-atlas", []string{"wrong-aud"}, time.Now().Add(time.Hour))

	// Create expired token
	expiredToken := createTestJWT(t, privateKey, "tempest-atlas", []string{"atlas"}, time.Now().Add(-time.Hour))

	middleware := jwtAuthMiddleware(publicKeyPEM)

	tests := []struct {
		name       string
		authHeader string
		wantStatus int
	}{
		{
			name:       "missing auth header",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid format - no Bearer",
			authHeader: "Basic abc123",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid format - empty token",
			authHeader: "Bearer ",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid JWT",
			authHeader: "Bearer not-a-jwt",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "wrong issuer",
			authHeader: "Bearer " + wrongIssuerToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "wrong audience",
			authHeader: "Bearer " + wrongAudienceToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "expired token",
			authHeader: "Bearer " + expiredToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid token",
			authHeader: "Bearer " + validToken,
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func createTestJWT(t *testing.T, privateKey *rsa.PrivateKey, issuer string, audience []string, expiresAt time.Time) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss": issuer,
		"aud": audience,
		"sub": "test-user",
		"exp": expiresAt.Unix(),
		"iat": time.Now().Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(privateKey)
	require.NoError(t, err)
	return signed
}

func exportRSAPublicKeyAsPEM(t *testing.T, pubkey *rsa.PublicKey) string {
	t.Helper()
	pubASN1, err := x509.MarshalPKIXPublicKey(pubkey)
	require.NoError(t, err)
	pubPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubASN1,
	})
	return string(pubPEM)
}

func testLogger() *httplog.Logger {
	return httplog.NewLogger("test", httplog.Options{
		LogLevel: slog.LevelError, // Suppress logs during tests
		JSON:     false,
	})
}
