// Package jwt provides JWT authentication middleware for HTTP handlers.
package jwt

import (
	"context"
	"crypto/rsa"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const userIDKey contextKey = "userID"

// ErrMissingUserID is returned when userID is not in context.
var ErrMissingUserID = errors.New("user ID not found in context")

// WithUserID adds a user ID to the context.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

// MustGetUserID extracts userID from context or returns an error.
func MustGetUserID(ctx context.Context) (string, error) {
	userID, ok := ctx.Value(userIDKey).(string)
	if !ok || userID == "" {
		return "", ErrMissingUserID
	}
	return userID, nil
}

// LoadRSAPublicKeyFromFile loads a PEM-encoded RSA public key from a file.
func LoadRSAPublicKeyFromFile(path string) (*rsa.PublicKey, error) {
	keyData, err := os.ReadFile(path) // #nosec G304 -- path from config
	if err != nil {
		return nil, err
	}
	return jwt.ParseRSAPublicKeyFromPEM(keyData)
}

// AuthMiddleware extracts tempest_user_id from the JWT and adds it to context.
// If publicKey is provided, the JWT signature is verified. Otherwise, tokens
// are parsed without verification (for local dev where traefik validates upstream).
func AuthMiddleware(publicKey *rsa.PublicKey, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				logger.Warn("jwt: missing Authorization header")
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Extract Bearer token
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				logger.Warn("jwt: invalid Authorization header format")
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			tokenString := parts[1]

			// Parse JWT - with or without verification
			var token *jwt.Token
			var err error
			if publicKey != nil {
				token, err = jwt.Parse(tokenString, func(t *jwt.Token) (any, error) {
					if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
						return nil, errors.New("unexpected signing method")
					}
					return publicKey, nil
				})
				if err != nil {
					logger.Warn("jwt: verification failed", "error", err)
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
			} else {
				parser := jwt.NewParser()
				token, _, err = parser.ParseUnverified(tokenString, jwt.MapClaims{})
				if err != nil {
					logger.Warn("jwt: failed to parse token", "error", err)
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
			}

			claims, ok := token.Claims.(jwt.MapClaims)
			if !ok {
				logger.Warn("jwt: invalid claims structure")
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Extract user_metadata.tempest_user_id
			userMetadata, ok := claims["user_metadata"].(map[string]any)
			if !ok {
				logger.Warn("jwt: missing user_metadata")
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			userID, ok := userMetadata["tempest_user_id"].(string)
			if !ok || userID == "" {
				logger.Warn("jwt: missing tempest_user_id")
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Add user ID to context and log fields
			ctx := WithUserID(r.Context(), userID)
			httplog.LogEntrySetFields(r.Context(), map[string]any{"userID": userID})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
