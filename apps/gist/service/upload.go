package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const maxUploadRetries = 3

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() { RecordUploadDuration(time.Since(start)) }()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	log := httplog.LogEntry(ctx)

	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "text/html") {
		RecordUpload("error")
		http.Error(w, "Content-Type must be text/html", http.StatusUnsupportedMediaType)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Error("failed to read body", "error", err)
		RecordUpload("error")
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if len(body) == 0 {
		RecordUpload("error")
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}

	storage, err := StorageClientFromContext(ctx)
	if err != nil {
		log.Error("storage client not in context", "error", err)
		RecordUpload("error")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Retry with new UUID if collision occurs (extremely unlikely with UUIDv4)
	var id uuid.UUID
	for i := 0; i < maxUploadRetries; i++ {
		id = uuid.New()
		if err = storage.Upload(ctx, id, body); err == nil {
			break
		}
		if !errors.Is(err, ErrObjectAlreadyExists) {
			break
		}
		log.Warn("UUID collision, retrying", "id", id.String(), "attempt", i+1)
	}
	if err != nil {
		log.Error("failed to upload to GCS", "error", err)
		RecordUpload("error")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	baseURL, err := ShareBaseURLFromContext(ctx)
	if err != nil {
		log.Error("share base URL not in context", "error", err)
		RecordUpload("error")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	shareURL := baseURL + "/space/" + id.String()

	// Extract user email from Bearer token for logging (permissive - no auth enforcement)
	userEmail := extractUserEmail(r)

	log.Info("gist uploaded", "id", id.String(), "url", shareURL, "user", userEmail)

	RecordUpload("success")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id.String(), "url": shareURL})
}

// extractUserEmail extracts the email claim from a Bearer token.
// This is permissive - it never rejects requests, just returns empty string on failure.
func extractUserEmail(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}

	tokenString := strings.TrimPrefix(authHeader, "Bearer ")

	// Parse without validation - just extract claims for logging
	token, _, err := jwt.NewParser().ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		return ""
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return ""
	}

	email, ok := claims["email"].(string)
	if !ok {
		return ""
	}

	return email
}
