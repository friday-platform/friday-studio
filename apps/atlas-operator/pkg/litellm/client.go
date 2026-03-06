package litellm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// Client is an HTTP client for the LiteLLM API.
type Client struct {
	endpoint   string
	masterKey  string
	timeout    time.Duration
	httpClient *http.Client
	logger     *slog.Logger
}

// Config holds configuration for the LiteLLM client.
type Config struct {
	Endpoint  string
	MasterKey string
}

const defaultTimeout = 10 * time.Second

// NewClient creates a new LiteLLM client.
func NewClient(cfg Config, logger *slog.Logger) (*Client, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid litellm endpoint URL %q: must be http or https", cfg.Endpoint)
	}

	return &Client{
		endpoint:   cfg.Endpoint,
		masterKey:  cfg.MasterKey,
		timeout:    defaultTimeout,
		httpClient: &http.Client{},
		logger:     logger,
	}, nil
}

// CreateVirtualKeyRequest is the request body for creating a virtual key.
type CreateVirtualKeyRequest struct {
	UserID         string            `json:"user_id"`
	KeyAlias       string            `json:"key_alias,omitempty"`
	MaxBudget      *float64          `json:"max_budget,omitempty"`
	BudgetDuration string            `json:"budget_duration,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

// CreateVirtualKeyResponse is the response from creating a virtual key.
type CreateVirtualKeyResponse struct {
	Key       string   `json:"key"`
	UserID    string   `json:"user_id"`
	ExpiresAt *string  `json:"expires"`
	Models    []string `json:"models"`
	MaxBudget *float64 `json:"max_budget"`
}

// CreateVirtualKey creates a new virtual key for a user.
func (c *Client) CreateVirtualKey(ctx context.Context, req CreateVirtualKeyRequest) (*CreateVirtualKeyResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	reqURL, err := url.JoinPath(c.endpoint, "/key/generate")
	if err != nil {
		return nil, fmt.Errorf("build request URL: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.masterKey)
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

	var result CreateVirtualKeyResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	c.logger.Info("Created LiteLLM virtual key",
		slog.String("user_id", req.UserID),
		slog.String("key_alias", req.KeyAlias),
	)

	return &result, nil
}

// deleteVirtualKeyRequest is the request body for deleting a virtual key by alias.
type deleteVirtualKeyRequest struct {
	KeyAliases []string `json:"key_aliases"`
}

// DeleteVirtualKeyByUserID deletes a virtual key by user ID.
// Uses the key_alias which is set to "atlas-{userID}" during creation.
func (c *Client) DeleteVirtualKeyByUserID(ctx context.Context, userID string) error {
	keyAlias := KeyAliasForUser(userID)
	body, err := json.Marshal(deleteVirtualKeyRequest{KeyAliases: []string{keyAlias}})
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	reqURL, err := url.JoinPath(c.endpoint, "/key/delete")
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.masterKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody))
	}

	c.logger.Info("Deleted LiteLLM virtual key",
		slog.String("user_id", userID),
		slog.String("key_alias", keyAlias),
	)

	return nil
}

// keyListResponse is the response from listing keys.
type keyListResponse struct {
	TotalCount int `json:"total_count"`
}

// HasKey checks if a user has at least one key in LiteLLM.
func (c *Client) HasKey(ctx context.Context, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	basePath, err := url.JoinPath(c.endpoint, "/key/list")
	if err != nil {
		return false, fmt.Errorf("build request URL: %w", err)
	}
	reqURL := fmt.Sprintf("%s?user_id=%s&page_size=1", basePath, url.QueryEscape(userID))
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.masterKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return false, fmt.Errorf("execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody))
	}

	var result keyListResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return false, fmt.Errorf("unmarshal response: %w", err)
	}

	return result.TotalCount > 0, nil
}

// KeyAliasForUser returns the key alias for a given user ID.
func KeyAliasForUser(userID string) string {
	return fmt.Sprintf("atlas-%s", userID)
}

// Float64Ptr returns a pointer to a float64 value.
func Float64Ptr(v float64) *float64 {
	return &v
}
