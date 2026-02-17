package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Standard Kubernetes service account paths and API endpoints.
const (
	k8sSATokenPath    = "/var/run/secrets/kubernetes.io/serviceaccount/token"                       // #nosec G101 -- not credentials
	k8sCAPath         = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"                      // #nosec G101 -- not credentials
	k8sTokenReviewURL = "https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews" // #nosec G101 -- API endpoint, not credentials
)

// K8sTokenInfo contains validated token information.
type K8sTokenInfo struct {
	PodName   string
	Namespace string
	Username  string // e.g., "system:serviceaccount:atlas-operator:atlas-operator"
}

// tokenReviewResponse is the Kubernetes TokenReview API response structure.
type tokenReviewResponse struct {
	Status struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			Username string              `json:"username"`
			UID      string              `json:"uid"`
			Extra    map[string][]string `json:"extra"`
		} `json:"user"`
		Error string `json:"error,omitempty"`
	} `json:"status"`
}

// validateK8sToken validates a Kubernetes service account token via TokenReview API.
func validateK8sToken(ctx context.Context, client *http.Client, token string) (*K8sTokenInfo, error) {
	// Read cypher's own SA token fresh each time (bound tokens can rotate)
	saToken, err := os.ReadFile(k8sSATokenPath)
	if err != nil {
		return nil, fmt.Errorf("read service account token: %w", err)
	}

	// Build TokenReview request
	review := map[string]any{
		"apiVersion": "authentication.k8s.io/v1",
		"kind":       "TokenReview",
		"spec":       map[string]string{"token": token},
	}
	body, _ := json.Marshal(review)

	// POST to K8s API
	req, err := http.NewRequestWithContext(ctx, "POST", k8sTokenReviewURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(saToken)))
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req) //nolint:gosec // G704: URL is const k8sTokenReviewURL
	if err != nil {
		return nil, fmt.Errorf("kubernetes API request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Check HTTP status before trying to decode
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("kubernetes API returned status %d", resp.StatusCode)
	}

	// Parse TokenReview response
	var reviewResp tokenReviewResponse
	if err := json.NewDecoder(resp.Body).Decode(&reviewResp); err != nil {
		return nil, fmt.Errorf("decode tokenreview response: %w", err)
	}

	// Check authentication result
	if !reviewResp.Status.Authenticated {
		if reviewResp.Status.Error != "" {
			return nil, fmt.Errorf("token not authenticated: %s", reviewResp.Status.Error)
		}
		return nil, errors.New("token not authenticated")
	}

	// Extract pod name from Extra claims
	podNames, ok := reviewResp.Status.User.Extra["authentication.kubernetes.io/pod-name"]
	if !ok || len(podNames) == 0 {
		return nil, errors.New("pod name not found in token claims")
	}

	// Extract namespace from username: "system:serviceaccount:<namespace>:<sa-name>"
	namespace := ""
	parts := strings.Split(reviewResp.Status.User.Username, ":")
	if len(parts) >= 3 {
		namespace = parts[2]
	}

	return &K8sTokenInfo{
		PodName:   podNames[0],
		Namespace: namespace,
		Username:  reviewResp.Status.User.Username,
	}, nil
}

// InitK8sHTTPClient creates an HTTP client for Kubernetes API calls.
// Returns (nil, nil) if not running in Kubernetes, (nil, err) on failure, (client, nil) on success.
func InitK8sHTTPClient() (*http.Client, error) {
	if _, err := os.Stat(k8sSATokenPath); os.IsNotExist(err) {
		return nil, nil // Not in Kubernetes
	}

	// Load Kubernetes CA cert for TLS verification
	caCert, err := os.ReadFile(k8sCAPath)
	if err != nil {
		return nil, fmt.Errorf("read Kubernetes CA cert: %w", err)
	}

	caCertPool := x509.NewCertPool()
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, errors.New("parse Kubernetes CA cert failed")
	}

	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:    caCertPool,
				MinVersion: tls.VersionTLS12,
			},
		},
	}, nil
}

// ParseUserIDFromPodName extracts user ID from pod name.
// Pod format: atlas-{user-id}-{replicaset-hash}-{pod-hash}.
// Example: atlas-5rkn85pd6ng809g-7d68747f7f-rl4s4 -> "5rkn85pd6ng809g".
func ParseUserIDFromPodName(podName string) (string, error) {
	remainder, found := strings.CutPrefix(podName, "atlas-")
	if !found {
		return "", errors.New("pod name must start with 'atlas-'")
	}

	// Split by "-" and we need at least 3 parts: user-id, replicaset-hash, pod-hash
	parts := strings.Split(remainder, "-")
	if len(parts) < 3 {
		return "", errors.New("invalid pod name format: expected atlas-{user-id}-{rs-hash}-{pod-hash}")
	}

	// User ID is everything except the last two parts (replicaset-hash and pod-hash)
	// This handles user IDs that might contain dashes
	userIDParts := parts[:len(parts)-2]
	userID := strings.Join(userIDParts, "-")

	if userID == "" {
		return "", errors.New("empty user ID in pod name")
	}

	return userID, nil
}
