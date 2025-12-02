package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	log := httplog.LogEntry(ctx)

	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "text/html") {
		http.Error(w, "Content-Type must be text/html", http.StatusUnsupportedMediaType)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Error("failed to read body", "error", err)
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if len(body) == 0 {
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}

	id := uuid.New()

	storage, err := StorageClientFromContext(ctx)
	if err != nil {
		log.Error("storage client not in context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := storage.Upload(ctx, id, body); err != nil {
		log.Error("failed to upload to GCS", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	baseURL, err := ShareBaseURLFromContext(ctx)
	if err != nil {
		log.Error("share base URL not in context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	shareURL := baseURL + "/space/" + id.String()

	// Extract user email from Bearer token for logging (permissive - no auth enforcement)
	userEmail := extractUserEmail(r)

	log.Info("gist uploaded", "id", id.String(), "url", shareURL, "user", userEmail)

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
