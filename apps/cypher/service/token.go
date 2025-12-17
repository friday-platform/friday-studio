package service

import (
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"
	"github.com/tempestteam/atlas/apps/cypher/repo"
)

// atlasUserNamespace is the namespace where user atlas pods run.
const atlasUserNamespace = "atlas"

// atlasUserSAPrefix is the prefix for user atlas service accounts.
// Full format: system:serviceaccount:atlas:atlas-sa-{user-id}.
const atlasUserSAPrefix = "system:serviceaccount:atlas:atlas-sa-"

// TokenDeps contains dependencies for the token endpoint.
type TokenDeps struct {
	JWTPrivateKey *rsa.PrivateKey
	Queries       *repo.Queries
}

// handleGeneratePodToken handles POST /api/atlas-token.
// K8s token validation is handled by K8sServiceAccountAuthMiddleware.
// Flow: extract pod name from tokenInfo -> parse user ID -> lookup user -> generate JWT.
func handleGeneratePodToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	deps, err := TokenDepsFromContext(ctx)
	if err != nil {
		RecordTokenIssued("failure")
		writeJSONError(w, "internal configuration error", http.StatusInternalServerError)
		return
	}

	// Get tokenInfo from context (set by K8sServiceAccountAuthMiddleware)
	tokenInfo, err := K8sTokenInfoFromContext(ctx)
	if err != nil {
		log.Error("token: no K8s token info in context", "error", err)
		RecordTokenIssued("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Verify caller is a user atlas pod (namespace: atlas, SA: atlas-sa-{user-id})
	if tokenInfo.Namespace != atlasUserNamespace || !strings.HasPrefix(tokenInfo.Username, atlasUserSAPrefix) {
		log.Warn("token: unauthorized caller",
			"namespace", tokenInfo.Namespace,
			"username", tokenInfo.Username,
		)
		RecordTokenIssued("failure")
		writeJSONError(w, "unauthorized", http.StatusForbidden)
		return
	}

	// Parse user ID from pod name
	userID, err := ParseUserIDFromPodName(tokenInfo.PodName)
	if err != nil {
		RecordTokenIssued("failure")
		writeJSONError(w, "invalid pod name format", http.StatusBadRequest)
		return
	}

	// Lookup user in database
	user, err := deps.Queries.GetUserByID(ctx, userID)
	if err != nil {
		RecordTokenIssued("failure")
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
		RecordTokenIssued("failure")
		writeJSONError(w, "token generation failed", http.StatusInternalServerError)
		return
	}

	RecordTokenIssued("success")

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
