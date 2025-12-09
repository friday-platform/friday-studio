package service

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/httplog/v2"
)

// DecryptRequest is the request body for /decrypt.
type DecryptRequest struct {
	Ciphertext [][]byte `json:"ciphertext"`
}

// DecryptResponse is the response body for /decrypt.
type DecryptResponse struct {
	Plaintext []string `json:"plaintext"`
}

// handleDecrypt decrypts one or more ciphertext values using the user's AEAD key.
func handleDecrypt(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	// Get user ID from context (set by auth middleware)
	userID, err := UserIDFromContext(ctx)
	if err != nil {
		log.Warn("decrypt: no user ID in context", "error", err)
		RecordDecrypt("failure")
		http.Error(w, `{"error": "unauthorized"}`, http.StatusUnauthorized)
		return
	}

	// Get key cache from context
	cache, err := KeyCacheFromContext(ctx)
	if err != nil {
		log.Error("decrypt: no key cache in context", "error", err)
		RecordDecrypt("failure")
		http.Error(w, `{"error": "internal error"}`, http.StatusInternalServerError)
		return
	}

	// Parse request body
	var req DecryptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Warn("decrypt: failed to decode request", "error", err)
		RecordDecrypt("failure")
		http.Error(w, `{"error": "invalid request body"}`, http.StatusBadRequest)
		return
	}

	if len(req.Ciphertext) == 0 {
		log.Warn("decrypt: empty ciphertext array")
		RecordDecrypt("failure")
		http.Error(w, `{"error": "ciphertext array cannot be empty"}`, http.StatusBadRequest)
		return
	}

	// Get AEAD primitive for user
	aead, err := cache.GetAEAD(ctx, userID)
	if err != nil {
		log.Error("decrypt: failed to get AEAD", "error", err, "userID", userID)
		RecordDecrypt("failure")
		http.Error(w, `{"error": "decryption failed"}`, http.StatusInternalServerError)
		return
	}

	// Decrypt each ciphertext value using user ID as AAD
	aad := []byte(userID)
	plaintext := make([]string, len(req.Ciphertext))
	for i, ct := range req.Ciphertext {
		pt, err := aead.Decrypt(ct, aad)
		if err != nil {
			log.Warn("decrypt: decryption failed", "error", err, "userID", userID, "index", i)
			RecordDecrypt("failure")
			http.Error(w, `{"error": "decryption failed"}`, http.StatusBadRequest)
			return
		}
		plaintext[i] = string(pt)
	}

	RecordDecrypt("success")

	// Write response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(DecryptResponse{Plaintext: plaintext}); err != nil {
		log.Error("decrypt: failed to encode response", "error", err)
	}
}
