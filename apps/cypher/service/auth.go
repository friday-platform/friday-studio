package service

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
)

// JWTAuthMiddleware extracts tempest_user_id from the JWT and adds it to context.
// If publicKeyPEM is provided, the JWT signature is verified. Otherwise, tokens
// are parsed without verification (for local dev where traefik validates upstream).
func JWTAuthMiddleware(publicKeyPEM string) func(next http.Handler) http.Handler {
	var verifyKey any
	if publicKeyPEM != "" {
		key, err := parsePublicKey(publicKeyPEM)
		if err != nil {
			panic("invalid JWT_PUBLIC_KEY: " + err.Error())
		}
		verifyKey = key
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			log := httplog.LogEntry(ctx)

			// Get token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				log.Warn("auth: missing Authorization header")
				writeJSONError(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			// Extract Bearer token
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				log.Warn("auth: invalid Authorization header format")
				writeJSONError(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			tokenString := parts[1]

			// Parse JWT - with or without verification
			var token *jwt.Token
			var err error
			if verifyKey != nil {
				token, err = jwt.Parse(tokenString, func(t *jwt.Token) (any, error) {
					return verifyKey, nil
				})
				if err != nil {
					log.Warn("auth: JWT verification failed", "error", err)
					writeJSONError(w, "unauthorized", http.StatusUnauthorized)
					return
				}
			} else {
				parser := jwt.NewParser()
				token, _, err = parser.ParseUnverified(tokenString, jwt.MapClaims{})
				if err != nil {
					log.Warn("auth: failed to parse JWT", "error", err)
					writeJSONError(w, "unauthorized", http.StatusUnauthorized)
					return
				}
			}

			claims, ok := token.Claims.(jwt.MapClaims)
			if !ok {
				log.Warn("auth: invalid JWT claims")
				writeJSONError(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			// Extract user_metadata.tempest_user_id
			userMetadata, ok := claims["user_metadata"].(map[string]any)
			if !ok {
				log.Warn("auth: missing user_metadata in JWT")
				writeJSONError(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			userID, ok := userMetadata["tempest_user_id"].(string)
			if !ok || userID == "" {
				log.Warn("auth: missing tempest_user_id in JWT")
				writeJSONError(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			// Add user ID to context
			ctx = WithUserID(ctx, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// parsePublicKey parses a PEM-encoded public key (RSA, ECDSA, or Ed25519).
func parsePublicKey(pemData string) (any, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, errors.New("failed to decode PEM block")
	}

	// Try PKIX format first (most common for public keys)
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err == nil {
		return pub, nil
	}

	// Try PKCS1 RSA public key
	rsaPub, err := x509.ParsePKCS1PublicKey(block.Bytes)
	if err == nil {
		return rsaPub, nil
	}

	return nil, errors.New("unsupported public key format")
}

// K8sServiceAccountAuthMiddleware validates K8s service account tokens and optionally
// checks against an allowlist. On success, adds K8sTokenInfo to context.
// If allowed is nil or empty, any authenticated token is accepted.
func K8sServiceAccountAuthMiddleware(client *http.Client, allowed []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			log := httplog.LogEntry(ctx)

			// Extract Bearer token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				log.Warn("k8s_auth: missing authorization header")
				writeJSONError(w, "authorization required", http.StatusUnauthorized)
				return
			}

			token, found := strings.CutPrefix(authHeader, "Bearer ")
			if !found || token == "" {
				log.Warn("k8s_auth: invalid authorization header format")
				writeJSONError(w, "invalid authorization header", http.StatusUnauthorized)
				return
			}

			// Validate K8s token via TokenReview API
			tokenInfo, err := validateK8sToken(ctx, client, token)
			if err != nil {
				log.Warn("k8s_auth: token validation failed", "error", err)
				writeJSONError(w, "invalid token", http.StatusUnauthorized)
				return
			}

			// Check against allowlist (skip if empty - allows any authenticated token)
			if len(allowed) > 0 && !slices.Contains(allowed, tokenInfo.Username) {
				log.Warn("k8s_auth: unauthorized service account",
					"username", tokenInfo.Username,
					"namespace", tokenInfo.Namespace,
				)
				writeJSONError(w, "unauthorized service account", http.StatusForbidden)
				return
			}

			log.Debug("k8s_auth: authenticated",
				"username", tokenInfo.Username,
				"namespace", tokenInfo.Namespace,
			)

			// Add token info to context
			ctx = context.WithValue(ctx, k8sTokenInfoContextKey, tokenInfo)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
