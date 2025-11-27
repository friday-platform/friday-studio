package extractuserid

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Config the plugin configuration.
type Config struct {
	CookieName   string `json:"cookieName,omitempty"`
	JWTPublicKey string `json:"jwtPublicKey,omitempty"`
	HeaderName   string `json:"headerName,omitempty"`
}

// CreateConfig creates the default plugin configuration.
func CreateConfig() *Config {
	return &Config{
		CookieName: "tempest_token",
		HeaderName: "X-Atlas-User-ID",
	}
}

// ExtractUserID plugin.
type ExtractUserID struct {
	next         http.Handler
	cookieName   string
	jwtPublicKey string
	headerName   string
	name         string
}

// LogEntry matches Traefik's access log format
type LogEntry struct {
	Time          string `json:"time"`
	Level         string `json:"level"`
	Msg           string `json:"msg"`
	UserID        string `json:"user_id,omitempty"`
	Error         string `json:"error,omitempty"`
	RequestMethod string `json:"RequestMethod,omitempty"`
	RequestPath   string `json:"RequestPath,omitempty"`
	RequestHost   string `json:"RequestHost,omitempty"`
	ClientAddr    string `json:"ClientAddr,omitempty"`
	StartLocal    string `json:"StartLocal,omitempty"`
	StartUTC      string `json:"StartUTC,omitempty"`
}

// New creates a new extractuserid plugin.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	if len(config.CookieName) == 0 {
		return nil, fmt.Errorf("no cookie name configured")
	}

	if len(config.JWTPublicKey) == 0 {
		return nil, fmt.Errorf("no public key configured")
	}

	if len(config.HeaderName) == 0 {
		return nil, fmt.Errorf("no header name configured")
	}

	ret := &ExtractUserID{
		next:         next,
		cookieName:   config.CookieName,
		jwtPublicKey: config.JWTPublicKey,
		headerName:   config.HeaderName,
		name:         name,
	}

	return ret, nil
}

func (p *ExtractUserID) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	// SECURITY: Delete any pre-existing header to prevent header injection attacks
	// This MUST be the first operation - remove the header before any validation
	req.Header.Del(p.headerName)

	// Extract JWT from cookie
	tokenString, ok := getJWT(req, p.cookieName)
	if !ok {
		// No JWT present - reject with 401 Unauthorized
		logError(req, "missing JWT cookie").print()
		http.Error(rw, "Unauthorized: Missing authentication token", http.StatusUnauthorized)
		return
	}

	// Read public key from file
	publicKeyPEM, err := readSecretFromFile(p.jwtPublicKey)
	if err != nil {
		logError(req, "error reading public key").withError(err).print()
		http.Error(rw, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// Verify JWT and extract claims
	token, err := verifyJWT(tokenString, publicKeyPEM)
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

	// Extract sub claim
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		logError(req, "failed to extract claims").print()
		http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
		return
	}

	sub, ok := claims["sub"].(string)
	if !ok || sub == "" {
		logError(req, "missing sub claim").print()
		http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
		return
	}

	// Set the header with user ID directly (lowercase alphanumeric, RFC 1123 compliant)
	req.Header.Set(p.headerName, sub)

	logInfo(req, "extracted user_id").withUserID(sub).print()

	// Pass to next handler
	p.next.ServeHTTP(rw, req)
}

func getJWT(req *http.Request, cookieName string) (string, bool) {
	// Extract JWT from cookie
	cookie, err := req.Cookie(cookieName)
	if err == nil && cookie != nil {
		return cookie.Value, true
	}
	return "", false
}

func verifyJWT(tokenString string, publicKeyPEM string) (*jwt.Token, error) {
	publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(publicKeyPEM))
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}

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

func readSecretFromFile(filepath string) (string, error) {
	data, err := os.ReadFile(filepath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// logInfo creates an info-level log entry with request context
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

// logError creates an error-level log entry with request context
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

func (e *LogEntry) withUserID(userID string) *LogEntry {
	e.UserID = userID
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
