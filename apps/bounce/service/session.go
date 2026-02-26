package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
)

type AAL int

const (
	AAL1 AAL = iota + 1
	AAL2
	AAL3
)

func (a AAL) String() string {
	switch a {
	case AAL1:
		return "AAL1"
	case AAL2:
		return "AAL2"
	case AAL3:
		return "AAL3"
	default:
		return "Unknown AAL"
	}
}

type AMREntry struct {
	Method    string `json:"method"`
	Timestamp int64  `json:"timestamp"`
	Provider  string `json:"provider,omitempty"`
}

// Derived from supabase/auth AccessTokenClaims.
type TempestClaims struct {
	claims *Claims
}

type Claims struct {
	jwt.RegisteredClaims
	Email        string         `json:"email"`
	UserMetadata map[string]any `json:"user_metadata"`
	// Role is a requirement for supabase APIs which use PostgREST
	Role                          string     `json:"role"`
	AuthenticatorAssuranceLevel   string     `json:"aal,omitempty"`
	AuthenticationMethodReference []AMREntry `json:"amr,omitempty"`
	// Supabase specific claims
	SessionId string `json:"session_id,omitempty"`
}

func NewTempestClaims(userID, email string) (*TempestClaims, error) {
	if userID == "" || email == "" {
		return nil, fmt.Errorf("userID or email is empty")
	}

	jwi := uuid.NewString()

	return &TempestClaims{
		claims: &Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Audience:  jwt.ClaimStrings{"atlas"},
				Subject:   userID,
				NotBefore: jwt.NewNumericDate(time.Now()),
				IssuedAt:  jwt.NewNumericDate(time.Now()),
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
				ID:        jwi,
			},
			UserMetadata: make(map[string]any),
			Email:        email,
			Role:         "authenticated",
			SessionId:    jwi,
		},
	}, nil
}

func newEmptyTempestClaims() *TempestClaims {
	return &TempestClaims{
		claims: &Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Audience:  jwt.ClaimStrings{"tempest"},
				NotBefore: jwt.NewNumericDate(time.Now()),
			},
			UserMetadata: make(map[string]any),
		},
	}
}

func (c *TempestClaims) SetAALLevel(level AAL) error {
	if len(c.claims.AuthenticationMethodReference) != int(level) {
		return fmt.Errorf("amr is missing required fields: %v", level)
	}
	c.claims.AuthenticatorAssuranceLevel = level.String()
	return nil
}

func (c *TempestClaims) SetAMR(amr *AMREntry) error {
	if amr == nil {
		return fmt.Errorf("amr is nil")
	}

	if amr.Method == "" || amr.Timestamp == 0 || amr.Provider == "" {
		return fmt.Errorf("amr is missing required fields: %v", amr)
	}

	c.claims.AuthenticationMethodReference = append(c.claims.AuthenticationMethodReference, *amr)
	return nil
}

func (c *TempestClaims) SignedString(keyContent string) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c.claims)
	privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(keyContent))
	if err != nil {
		return "", fmt.Errorf("failed to parse RSA private key: %w", err)
	}
	return tok.SignedString(privateKey)
}

// SetTempestUserID is needed while transitioning from supabase/auth.
func (c *TempestClaims) SetTempestUserID(id string) {
	c.claims.UserMetadata["tempest_user_id"] = id
}

func (c *TempestClaims) SetTempestAuthUserId(id string) {
	c.claims.UserMetadata["tempest_auth_user_id"] = id
}

func ParseTempestClaimsFromJWT(secret, accessToken string) (*TempestClaims, error) {
	claims := newEmptyTempestClaims()

	_, err := jwt.ParseWithClaims(accessToken, claims.claims, func(token *jwt.Token) (any, error) {
		publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(secret))
		if err != nil {
			return nil, fmt.Errorf("failed to parse RSA public key: %w", err)
		}
		return publicKey, nil
	})
	if err != nil {
		return nil, err
	}

	return claims, nil
}

func TempestTokenFromCookies(cfg *Config, r *http.Request) (string, error) {
	cookie, err := r.Cookie(cfg.CookieName)
	if err != nil {
		return "", err
	}

	return cookie.Value, nil
}

func setCookieTempestToken(cfg *Config, w http.ResponseWriter, token string, expiresAt time.Time) error {
	secureFlag := !strings.HasSuffix(cfg.CookieDomain, "localhost")

	if expiresAt.IsZero() {
		return errors.New("expiresAt is zero")
	}

	http.SetCookie(w, &http.Cookie{
		Name:     cfg.CookieName,
		Value:    token,
		Expires:  expiresAt,
		Domain:   cfg.CookieDomain,
		MaxAge:   int((time.Hour * 24).Seconds()),
		Path:     "/",
		HttpOnly: true,
		Secure:   secureFlag,
		SameSite: http.SameSiteLaxMode,
	})

	return nil
}

func DeleteTempestTokenCookie(cfg *Config, w http.ResponseWriter) {
	secureFlag := !strings.HasSuffix(cfg.CookieDomain, "localhost")

	http.SetCookie(w, &http.Cookie{
		Name:     cfg.CookieName,
		Value:    "",
		Domain:   cfg.CookieDomain,
		Path:     "/",
		Expires:  time.Now().Add(-time.Hour),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureFlag,
		SameSite: http.SameSiteLaxMode,
	})
}

const botGateCookieBaseName = "bot_gate"

// Must match GATE_DELAY_MS in apps/atlas-auth-ui/src/lib/bot-gate.svelte.ts.
const (
	botGateMinAge = 3 * time.Second
	botGateMaxAge = 15 * time.Minute
)

// botGateCookieName returns __Host-bot_gate for production and bot_gate for
// localhost. __Host- prefix requires Secure, Path=/, and no Domain attribute,
// which prevents subdomain cookie tossing. Localhost falls back to the plain
// name since __Host- requires a secure origin.
func botGateCookieName(cookieDomain string) string {
	if strings.HasSuffix(cookieDomain, "localhost") {
		return botGateCookieBaseName
	}
	return "__Host-" + botGateCookieBaseName
}

// botGateMAC computes HMAC-SHA256(secret+"-botgate", "timestamp:" || SHA256(token)).
// The "-botgate" key suffix provides domain separation from other HMAC uses of
// SignupHMACSecret (e.g. OTP generation). The ":" delimiter prevents ambiguity
// between the variable-length timestamp and the fixed-length token hash.
func botGateMAC(secret, token string, tsMs int64) string {
	tokenHash := sha256.Sum256([]byte(token))
	h := hmac.New(sha256.New, []byte(secret+"-botgate"))
	_, _ = fmt.Fprintf(h, "%d:", tsMs) //nolint:gosec // G705: writing to hmac.Hash, not http.ResponseWriter
	h.Write(tokenHash[:])
	return hex.EncodeToString(h.Sum(nil))
}

// setBotGateCookie sets an HMAC-signed timing cookie during the GET redirect.
// The POST handler validates this to detect scanners that skip the GET or
// click faster than a human can.
func setBotGateCookie(w http.ResponseWriter, cfg Config, token string) {
	secureFlag := !strings.HasSuffix(cfg.CookieDomain, "localhost")
	tsMs := time.Now().UnixMilli()
	mac := botGateMAC(cfg.SignupHMACSecret, token, tsMs)
	cookie := &http.Cookie{
		Name:     botGateCookieName(cfg.CookieDomain),
		Value:    fmt.Sprintf("%d:%s", tsMs, mac),
		Path:     "/",
		MaxAge:   900,
		HttpOnly: true,
		Secure:   secureFlag,
		SameSite: http.SameSiteLaxMode,
	}
	// __Host- prefix requires no Domain attribute. On localhost we still need
	// Domain for cross-port cookie sharing during development.
	if !secureFlag {
		cookie.Domain = cfg.CookieDomain
	}
	http.SetCookie(w, cookie)
}

// validateBotGateCookie checks the timing cookie from the GET redirect.
// Missing = scanner skipped the GET. Bad HMAC = forged cookie or different
// token. Too young = scanner clicked faster than the gate allows.
// Too old = stale/replayed cookie.
func validateBotGateCookie(r *http.Request, cfg Config, token string) error {
	name := botGateCookieName(cfg.CookieDomain)
	cookie, err := r.Cookie(name)
	if err != nil {
		return fmt.Errorf("missing %s cookie", name)
	}
	parts := strings.SplitN(cookie.Value, ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid %s cookie format", name)
	}
	tsMs, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid %s cookie timestamp", name)
	}
	expectedMAC := botGateMAC(cfg.SignupHMACSecret, token, tsMs)
	if !hmac.Equal([]byte(parts[1]), []byte(expectedMAC)) {
		return fmt.Errorf("invalid %s cookie signature", name)
	}
	age := time.Since(time.UnixMilli(tsMs))
	if age < botGateMinAge {
		return fmt.Errorf("POST arrived %v after GET, minimum %v", age, botGateMinAge)
	}
	if age > botGateMaxAge {
		return fmt.Errorf("cookie expired: age %v exceeds %v", age, botGateMaxAge)
	}
	return nil
}

type SessionConfig struct {
	User       *bouncerepo.User
	AuthUser   *bouncerepo.BounceAuthUser
	AMREntries []*AMREntry
}

func SetNewSessionCookie(ctx context.Context, w http.ResponseWriter, cfg Config, sessionConfig *SessionConfig) error {
	log := httplog.LogEntry(ctx)
	tu := sessionConfig.User

	tc, err := NewTempestClaims(
		tu.ID,
		tu.Email,
	)
	if err != nil {
		log.Error("Could not create TempestClaims", "error", err)
		return err
	}

	tc.SetTempestUserID(tu.ID)
	tc.SetTempestAuthUserId(sessionConfig.AuthUser.ID)

	var amrErrs []error
	for _, amr := range sessionConfig.AMREntries {
		err := tc.SetAMR(amr)
		if err != nil {
			log.Error("Could not set AMR", "error", err)
			amrErrs = append(amrErrs, err)
		}
	}
	if len(amrErrs) > 0 {
		log.Error("Could not set AMR", "errors", amrErrs)
		return fmt.Errorf("could not set AMR: %v", amrErrs)
	}

	aal := AAL(len(sessionConfig.AMREntries))
	err = tc.SetAALLevel(aal)
	if err != nil {
		log.Error("Could not set AAL", "error", err)
		return err
	}

	tempestToken, err := tc.SignedString(cfg.JWTPrivateKey)
	if err != nil {
		log.Error("Could not sign JWT", "error", err)
		return err
	}

	expiresAt := tc.claims.ExpiresAt.Time
	err = setCookieTempestToken(&cfg, w, tempestToken, expiresAt)
	if err != nil {
		log.Error("Could not set cookie", "error", err)
		return err
	}

	return nil
}

func sessionCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Failed to get config from context", "error", err)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	token, err := TempestTokenFromCookies(&cfg, r)
	if err != nil {
		log.Info("Failed to get tempest token from cookies", "error", err)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	_, err = ParseTempestClaimsFromJWT(cfg.JWTPublicKey, token)
	if err != nil {
		log.Info("Failed to parse tempest token", "error", err)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	w.WriteHeader(http.StatusOK)
}
