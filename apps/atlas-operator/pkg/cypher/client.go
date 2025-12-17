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
	"os"
	"strings"
	"time"
)

// Standard Kubernetes service account paths.
var (
	k8sSATokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token" //nolint:gosec // Not credentials, just a file path
	k8sCAPath      = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

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
}

const defaultTimeout = 10 * time.Second

// NewClient creates a new Cypher client.
// It configures TLS to trust the Kubernetes CA if running in-cluster.
func NewClient(cfg Config, logger *slog.Logger) (*Client, error) {
	transport := &http.Transport{}

	// If running in Kubernetes, load the CA cert for TLS
	if _, err := os.Stat(k8sCAPath); err == nil {
		caCert, err := os.ReadFile(k8sCAPath)
		if err != nil {
			return nil, fmt.Errorf("read kubernetes CA cert: %w", err)
		}

		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("parse kubernetes CA cert")
		}

		transport.TLSClientConfig = &tls.Config{
			RootCAs:    caCertPool,
			MinVersion: tls.VersionTLS12,
		}
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

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/internal/encrypt", bytes.NewReader(body))
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
