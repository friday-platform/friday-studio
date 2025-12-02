package atlaskey

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Config the plugin configuration.
type Config struct {
	JWTPublicKey string `json:"jwtPublicKey,omitempty"`
	HeaderName   string `json:"headerName,omitempty"`
	Issuer       string `json:"issuer,omitempty"`
	Audience     string `json:"audience,omitempty"`
}

// CreateConfig creates the default plugin configuration.
func CreateConfig() *Config {
	return &Config{
		HeaderName: "X-Atlas-User-Email",
		Issuer:     "tempest-atlas",
		Audience:   "atlas",
	}
}

// AtlasKey plugin.
type AtlasKey struct {
	next       http.Handler
	publicKey  *rsa.PublicKey
	headerName string
	issuer     string
	audience   string
}

// LogEntry matches Traefik's access log format.
type LogEntry struct {
	Time          string `json:"time"`
	Level         string `json:"level"`
	Msg           string `json:"msg"`
	UserEmail     string `json:"user_email,omitempty"`
	Error         string `json:"error,omitempty"`
	RequestMethod string `json:"RequestMethod,omitempty"`
	RequestPath   string `json:"RequestPath,omitempty"`
	RequestHost   string `json:"RequestHost,omitempty"`
	ClientAddr    string `json:"ClientAddr,omitempty"`
	StartLocal    string `json:"StartLocal,omitempty"`
	StartUTC      string `json:"StartUTC,omitempty"`
}

// New creates a new atlaskey plugin.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	if len(config.JWTPublicKey) == 0 {
		return nil, fmt.Errorf("no public key path configured")
	}

	if len(config.HeaderName) == 0 {
		return nil, fmt.Errorf("no header name configured")
	}

	if len(config.Issuer) == 0 {
		return nil, fmt.Errorf("no issuer configured")
	}

	if len(config.Audience) == 0 {
		return nil, fmt.Errorf("no audience configured")
	}

	// Read and parse public key at plugin creation time
	publicKeyPEM, err := os.ReadFile(config.JWTPublicKey)
	if err != nil {
		return nil, fmt.Errorf("failed to read public key file: %w", err)
	}

	publicKey, err := jwt.ParseRSAPublicKeyFromPEM(publicKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}

	return &AtlasKey{
		next:       next,
		publicKey:  publicKey,
		headerName: config.HeaderName,
		issuer:     config.Issuer,
		audience:   config.Audience,
	}, nil
}

func (p *AtlasKey) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	// SECURITY: Delete any pre-existing header to prevent header injection attacks
	req.Header.Del(p.headerName)

	// Extract JWT from Authorization Bearer header
	tokenString, ok := getBearerToken(req)
	if !ok {
		logError(req, "missing or invalid Authorization header").print()
		http.Error(rw, "Unauthorized: Missing authentication token", http.StatusUnauthorized)
		return
	}

	// Verify JWT and extract claims
	token, err := verifyJWT(tokenString, p.publicKey)
	if err != nil {
		logError(req, "invalid JWT").withError(err).print()
		http.Error(rw, "Unauthorized: Invalid authentication token", http.StatusUnauthorized)
		return
	}

	if token == nil || !token.Valid {
		logError(req, "token not valid").print()
		http.Error(rw, "Unauthorized: Invalid authentication token", http.StatusUnauthorized)
		return
	}

	// Extract claims
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		logError(req, "failed to extract claims").print()
		http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
		return
	}

	// Validate issuer
	iss, ok := claims["iss"].(string)
	if !ok || iss != p.issuer {
		logError(req, "invalid issuer").print()
		http.Error(rw, "Unauthorized: Invalid token issuer", http.StatusUnauthorized)
		return
	}

	// Validate audience
	if !validateAudience(claims, p.audience) {
		logError(req, "invalid audience").print()
		http.Error(rw, "Unauthorized: Invalid token audience", http.StatusUnauthorized)
		return
	}

	// Extract email claim
	email, ok := claims["email"].(string)
	if !ok || email == "" {
		logError(req, "missing email claim").print()
		http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
		return
	}

	// Set the header with user email
	req.Header.Set(p.headerName, email)

	logInfo(req, "validated atlas key").withUserEmail(email).print()

	// Pass to next handler
	p.next.ServeHTTP(rw, req)
}

func getBearerToken(req *http.Request) (string, bool) {
	authHeader := req.Header.Get("Authorization")
	if authHeader == "" {
		return "", false
	}

	if !strings.HasPrefix(authHeader, "Bearer ") {
		return "", false
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token == "" {
		return "", false
	}

	return token, true
}

func verifyJWT(tokenString string, publicKey *rsa.PublicKey) (*jwt.Token, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return publicKey, nil
	})
	if err != nil {
		return nil, err
	}
	return token, nil
}

func validateAudience(claims jwt.MapClaims, expectedAudience string) bool {
	aud, ok := claims["aud"]
	if !ok {
		return false
	}

	// Audience can be a string or array of strings
	switch v := aud.(type) {
	case string:
		return v == expectedAudience
	case []interface{}:
		for _, a := range v {
			if str, ok := a.(string); ok && str == expectedAudience {
				return true
			}
		}
	}
	return false
}

func logInfo(req *http.Request, msg string) *LogEntry {
	now := time.Now()
	return &LogEntry{
		Time:          now.Format(time.RFC3339),
		Level:         "info",
		Msg:           msg,
		RequestMethod: req.Method,
		RequestPath:   req.URL.Path,
		RequestHost:   req.Host,
		ClientAddr:    req.RemoteAddr,
		StartLocal:    now.Format(time.RFC3339Nano),
		StartUTC:      now.UTC().Format(time.RFC3339Nano),
	}
}

func logError(req *http.Request, msg string) *LogEntry {
	now := time.Now()
	return &LogEntry{
		Time:          now.Format(time.RFC3339),
		Level:         "error",
		Msg:           msg,
		RequestMethod: req.Method,
		RequestPath:   req.URL.Path,
		RequestHost:   req.Host,
		ClientAddr:    req.RemoteAddr,
		StartLocal:    now.Format(time.RFC3339Nano),
		StartUTC:      now.UTC().Format(time.RFC3339Nano),
	}
}

func (e *LogEntry) withUserEmail(email string) *LogEntry {
	e.UserEmail = email
	return e
}

func (e *LogEntry) withError(err error) *LogEntry {
	if err != nil {
		e.Error = err.Error()
	}
	return e
}

func (e *LogEntry) print() {
	jsonBytes, _ := json.Marshal(e)
	fmt.Println(string(jsonBytes))
}
