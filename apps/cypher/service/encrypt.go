package service

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/httplog/v2"
)

// EncryptRequest is the request body for /encrypt.
type EncryptRequest struct {
	Plaintext []string `json:"plaintext"`
}

// EncryptResponse is the response body for /encrypt.
type EncryptResponse struct {
	Ciphertext [][]byte `json:"ciphertext"`
}

// handleEncrypt encrypts one or more plaintext values using the user's AEAD key.
func handleEncrypt(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	// Get user ID from context (set by auth middleware)
	userID, err := UserIDFromContext(ctx)
	if err != nil {
		log.Warn("encrypt: no user ID in context", "error", err)
		RecordEncrypt("failure")
		writeJSONError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Get key cache from context
	cache, err := KeyCacheFromContext(ctx)
	if err != nil {
		log.Error("encrypt: no key cache in context", "error", err)
		RecordEncrypt("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Parse request body
	var req EncryptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Warn("encrypt: failed to decode request", "error", err)
		RecordEncrypt("failure")
		writeJSONError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.Plaintext) == 0 {
		log.Warn("encrypt: empty plaintext array")
		RecordEncrypt("failure")
		writeJSONError(w, "plaintext array cannot be empty", http.StatusBadRequest)
		return
	}

	// Get or create AEAD primitive for user
	aead, err := cache.GetAEAD(ctx, userID)
	if err != nil {
		log.Error("encrypt: failed to get AEAD", "error", err, "userID", userID)
		RecordEncrypt("failure")
		writeJSONError(w, "encryption failed", http.StatusInternalServerError)
		return
	}

	// Encrypt each plaintext value using user ID as AAD
	aad := []byte(userID)
	ciphertext := make([][]byte, len(req.Plaintext))
	for i, pt := range req.Plaintext {
		ct, err := aead.Encrypt([]byte(pt), aad)
		if err != nil {
			log.Error("encrypt: encryption failed", "error", err, "userID", userID, "index", i)
			RecordEncrypt("failure")
			writeJSONError(w, "encryption failed", http.StatusInternalServerError)
			return
		}
		ciphertext[i] = ct
	}

	RecordEncrypt("success")

	// Write response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(EncryptResponse{Ciphertext: ciphertext}); err != nil {
		log.Error("encrypt: failed to encode response", "error", err)
	}
}
