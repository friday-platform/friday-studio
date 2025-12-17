package service

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"
)

// handleGetCredentials returns shared and per-user credentials.
func handleGetCredentials(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	userID, err := UserIDFromContext(ctx)
	if err != nil {
		RecordCredentials("failure")
		writeJSONError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	deps, err := CredentialsDepsFromContext(ctx)
	if err != nil {
		log.Error("credentials: no deps in context", "error", err)
		RecordCredentials("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	cache, err := KeyCacheFromContext(ctx)
	if err != nil {
		log.Error("credentials: no cache in context", "error", err)
		RecordCredentials("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	creds := map[string]string{}

	// Add shared secrets (always present if configured)
	if deps.SendgridKey != "" {
		creds["SENDGRID_API_KEY"] = deps.SendgridKey
	}
	if deps.ParallelKey != "" {
		creds["PARALLEL_API_KEY"] = deps.ParallelKey
	}

	// Add per-user LiteLLM key (may not exist yet - that's OK)
	ciphertext, err := deps.Queries.GetVirtualKeyCiphertext(ctx, userID)
	if err == nil {
		aead, err := cache.GetAEAD(ctx, userID)
		if err == nil {
			plaintext, err := aead.Decrypt(ciphertext, []byte(userID))
			if err == nil {
				creds["LITELLM_API_KEY"] = string(plaintext)
			} else {
				log.Warn("credentials: decrypt failed", "error", err, "userID", userID)
			}
		} else {
			log.Error("credentials: get aead failed", "error", err, "userID", userID)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		log.Error("credentials: query failed", "error", err, "userID", userID)
	}
	// If no virtual key (ErrNoRows), just omit LITELLM_API_KEY - user created before LiteLLM

	RecordCredentials("success")

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"credentials": creds})
}
