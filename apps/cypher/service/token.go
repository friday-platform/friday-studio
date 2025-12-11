package service

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/tempestteam/atlas/apps/cypher/repo"
)

// Standard Kubernetes service account paths.
const (
	k8sSATokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"  // #nosec G101 -- not credentials
	k8sCAPath      = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt" // #nosec G101 -- not credentials
)

// TokenDeps contains dependencies for the token endpoint.
type TokenDeps struct {
	K8sHTTPClient *http.Client
	JWTPrivateKey *rsa.PrivateKey
	Queries       *repo.Queries
}

// K8sTokenInfo contains validated token information.
type K8sTokenInfo struct {
	PodName   string
	Namespace string
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

// AtlasTokenClaims defines the JWT claims structure.
type AtlasTokenClaims struct {
	Email        string `json:"email,omitempty"`
	UserMetadata struct {
		TempestUserID string `json:"tempest_user_id"`
	} `json:"user_metadata"`
	jwt.RegisteredClaims
}

// handleGeneratePodToken handles POST /api/atlas-token.
// Flow: validate Kubernetes token -> extract pod name -> parse user ID -> lookup user -> generate JWT.
func handleGeneratePodToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	deps, err := TokenDepsFromContext(ctx)
	if err != nil {
		writeJSONError(w, "internal configuration error", http.StatusInternalServerError)
		return
	}

	// Parse request body
	var req struct {
		K8sToken string `json:"k8s_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.K8sToken == "" {
		writeJSONError(w, "missing k8s_token", http.StatusBadRequest)
		return
	}

	// Validate Kubernetes token and extract pod name
	tokenInfo, err := validateK8sToken(ctx, deps.K8sHTTPClient, req.K8sToken)
	if err != nil {
		log.Warn("Kubernetes token validation failed", "error", err)
		writeJSONError(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// Parse user ID from pod name
	userID, err := ParseUserIDFromPodName(tokenInfo.PodName)
	if err != nil {
		writeJSONError(w, "invalid pod name format", http.StatusBadRequest)
		return
	}

	// Lookup user in database
	user, err := deps.Queries.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, "user not found", http.StatusNotFound)
		} else {
			log.Error("Database error looking up user", "error", err, "userID", userID)
			writeJSONError(w, "database error", http.StatusInternalServerError)
		}
		return
	}

	// Generate JWT
	token, expiresAt, err := generateJWT(deps.JWTPrivateKey, *user)
	if err != nil {
		log.Error("JWT generation failed", "error", err)
		writeJSONError(w, "token generation failed", http.StatusInternalServerError)
		return
	}

	// AUDIT LOG: Record successful token issuance
	log.Info("Issued pod token",
		"userID", userID,
		"podName", tokenInfo.PodName,
		"namespace", tokenInfo.Namespace,
		"expiresAt", expiresAt.Format(time.RFC3339),
	)

	// Return response
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"token":      token,
		"expires_at": expiresAt.Format(time.RFC3339),
	})
}

// writeJSONError writes a JSON error response with proper Content-Type.
func writeJSONError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
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
	req, err := http.NewRequestWithContext(ctx, "POST",
		"https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(saToken)))
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
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

// generateJWT creates a signed JWT token for the user.
func generateJWT(privateKey *rsa.PrivateKey, user repo.GetUserByIDRow) (string, time.Time, error) {
	expiresAt := time.Now().Add(365 * 24 * time.Hour)

	// Use email as subject if available, otherwise use user ID
	subject := user.Email
	if subject == "" {
		subject = user.ID
	}

	claims := AtlasTokenClaims{
		Email: user.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "tempest-atlas",
			Audience:  jwt.ClaimStrings{"atlas"},
			Subject:   subject,
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	claims.UserMetadata.TempestUserID = user.ID

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(privateKey)
	if err != nil {
		return "", time.Time{}, err
	}

	return signed, expiresAt, nil
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

// ParsePrivateKey parses a PEM-encoded PKCS#8 RSA private key.
func ParsePrivateKey(pemData string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, errors.New("failed to decode PEM block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA private key")
	}
	return rsaKey, nil
}
