package cypher

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Standard Kubernetes service account token path.
var k8sSATokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token" //nolint:gosec // Not credentials, just a file path

// Client is an HTTP client for the Cypher /internal/encrypt endpoint.
type Client struct {
	endpoint   string
	timeout    time.Duration
	httpClient *http.Client
	logger     *slog.Logger
}

// Config holds configuration for the Cypher client.
type Config struct {
	Endpoint string
	RootCAs  *x509.CertPool // CA cert pool for TLS verification
}

const defaultTimeout = 10 * time.Second

// NewClient creates a new Cypher client.
// It configures TLS to trust the provided CA certificate pool.
func NewClient(cfg Config, logger *slog.Logger) (*Client, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid cypher endpoint URL %q: must be http or https", cfg.Endpoint)
	}

	transport := &http.Transport{}

	if cfg.RootCAs != nil {
		transport.TLSClientConfig = &tls.Config{
			RootCAs:    cfg.RootCAs,
			MinVersion: tls.VersionTLS12,
		}
		logger.Info("Configured Cypher client with custom CA")
	} else {
		logger.Warn("Cypher client using system CA roots")
	}

	return &Client{
		endpoint: cfg.Endpoint,
		timeout:  defaultTimeout,
		httpClient: &http.Client{
			Transport: transport,
		},
		logger: logger,
	}, nil
}

// EncryptRequest is the request body for /internal/encrypt.
type EncryptRequest struct {
	UserID    string   `json:"user_id"`
	Plaintext []string `json:"plaintext"`
}

// EncryptResponse is the response from /internal/encrypt.
type EncryptResponse struct {
	Ciphertext [][]byte `json:"ciphertext"`
}

// Encrypt encrypts plaintext values for a user via the Cypher /internal/encrypt endpoint.
// Uses Kubernetes service account token for authentication.
func (c *Client) Encrypt(ctx context.Context, userID string, plaintext []string) ([][]byte, error) {
	// Read fresh K8s SA token (bound tokens can rotate)
	saToken, err := os.ReadFile(k8sSATokenPath)
	if err != nil {
		return nil, fmt.Errorf("read service account token: %w", err)
	}

	body, err := json.Marshal(EncryptRequest{
		UserID:    userID,
		Plaintext: plaintext,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	reqURL, err := url.JoinPath(c.endpoint, "/internal/encrypt")
	if err != nil {
		return nil, fmt.Errorf("build request URL: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(saToken)))
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody))
	}

	var result EncryptResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	c.logger.Debug("Encrypted data via Cypher",
		slog.String("user_id", userID),
		slog.Int("count", len(result.Ciphertext)),
	)

	return result.Ciphertext, nil
}
