package service

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/httplog/v2"
)

// InternalEncryptRequest is the request body for /internal/encrypt.
type InternalEncryptRequest struct {
	UserID    string   `json:"user_id"`
	Plaintext []string `json:"plaintext"`
}

// AllowedInternalServiceAccounts lists the service accounts authorized to call /internal/encrypt.
var AllowedInternalServiceAccounts = []string{
	"system:serviceaccount:atlas-operator:atlas-operator",
}

// handleInternalEncrypt encrypts data for internal services (atlas-operator).
// Auth is handled by K8sServiceAccountAuthMiddleware.
func handleInternalEncrypt(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	// Get authenticated caller info from context (set by middleware)
	tokenInfo, err := K8sTokenInfoFromContext(ctx)
	if err != nil {
		log.Error("internal_encrypt: no token info in context", "error", err)
		RecordInternalEncrypt("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	var req InternalEncryptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Warn("internal_encrypt: invalid request", "error", err)
		RecordInternalEncrypt("failure")
		writeJSONError(w, "invalid request", http.StatusBadRequest)
		return
	}

	if req.UserID == "" {
		RecordInternalEncrypt("failure")
		writeJSONError(w, "user_id required", http.StatusBadRequest)
		return
	}

	if len(req.Plaintext) == 0 {
		RecordInternalEncrypt("failure")
		writeJSONError(w, "plaintext required", http.StatusBadRequest)
		return
	}

	cache, err := KeyCacheFromContext(ctx)
	if err != nil {
		log.Error("internal_encrypt: no cache", "error", err)
		RecordInternalEncrypt("failure")
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}

	aead, err := cache.GetAEAD(ctx, req.UserID)
	if err != nil {
		log.Error("internal_encrypt: get aead failed", "error", err, "userID", req.UserID)
		RecordInternalEncrypt("failure")
		writeJSONError(w, "encryption failed", http.StatusInternalServerError)
		return
	}

	aad := []byte(req.UserID)
	ciphertexts := make([][]byte, len(req.Plaintext))
	for i, pt := range req.Plaintext {
		ct, err := aead.Encrypt([]byte(pt), aad)
		if err != nil {
			log.Error("internal_encrypt: encrypt failed", "error", err, "index", i)
			RecordInternalEncrypt("failure")
			writeJSONError(w, "encryption failed", http.StatusInternalServerError)
			return
		}
		ciphertexts[i] = ct
	}

	RecordInternalEncrypt("success")
	log.Info("internal_encrypt: success",
		"userID", req.UserID,
		"count", len(ciphertexts),
		"caller", tokenInfo.Username,
	)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(EncryptResponse{Ciphertext: ciphertexts}); err != nil {
		log.Error("internal_encrypt: failed to encode response", "error", err)
	}
}
