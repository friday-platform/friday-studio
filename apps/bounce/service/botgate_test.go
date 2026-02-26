package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testMAC mirrors botGateMAC for test cookie construction.
func testMAC(secret, token string, tsMs int64) string {
	tokenHash := sha256.Sum256([]byte(token))
	h := hmac.New(sha256.New, []byte(secret+"-botgate"))
	_, _ = fmt.Fprintf(h, "%d:", tsMs)
	h.Write(tokenHash[:])
	return hex.EncodeToString(h.Sum(nil))
}

func validCookie(cfg Config, token string, age time.Duration) *http.Cookie {
	tsMs := time.Now().Add(-age).UnixMilli()
	mac := testMAC(cfg.SignupHMACSecret, token, tsMs)
	return &http.Cookie{
		Name:  botGateCookieName(cfg.CookieDomain),
		Value: fmt.Sprintf("%d:%s", tsMs, mac),
	}
}

func TestValidateBotGateCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret-key",
	}
	cookieName := botGateCookieName(cfg.CookieDomain)
	testToken := "abc123def456"

	tests := []struct {
		name    string
		cookie  *http.Cookie
		token   string
		wantErr string
	}{
		{
			name:    "missing cookie",
			cookie:  nil,
			token:   testToken,
			wantErr: "missing",
		},
		{
			name:    "invalid cookie format (no colon)",
			cookie:  &http.Cookie{Name: cookieName, Value: "not-a-valid-format"},
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name:    "invalid timestamp",
			cookie:  &http.Cookie{Name: cookieName, Value: "abc:def"},
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name: "wrong HMAC signature",
			cookie: &http.Cookie{
				Name:  cookieName,
				Value: fmt.Sprintf("%d:%s", time.Now().Add(-4*time.Second).UnixMilli(), "deadbeef"),
			},
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name:    "wrong token binding",
			cookie:  validCookie(cfg, "different-token", 4*time.Second),
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name:    "cookie too young",
			cookie:  validCookie(cfg, testToken, 0),
			token:   testToken,
			wantErr: "POST arrived",
		},
		{
			name:    "cookie expired",
			cookie:  validCookie(cfg, testToken, 20*time.Minute),
			token:   testToken,
			wantErr: "cookie expired",
		},
		{
			name:   "valid at minimum age boundary",
			cookie: validCookie(cfg, testToken, 4*time.Second),
			token:  testToken,
		},
		{
			name:   "valid well within window",
			cookie: validCookie(cfg, testToken, 30*time.Second),
			token:  testToken,
		},
		{
			name:   "valid near max age",
			cookie: validCookie(cfg, testToken, 14*time.Minute),
			token:  testToken,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", nil)
			if tt.cookie != nil {
				req.AddCookie(tt.cookie)
			}

			err := validateBotGateCookie(req, cfg, tt.token)

			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSetBotGateCookie(t *testing.T) {
	t.Run("sets cookie with __Host- prefix and no Domain", func(t *testing.T) {
		w := httptest.NewRecorder()
		cfg := Config{CookieDomain: "friday.ai", SignupHMACSecret: "test-secret"}

		setBotGateCookie(w, cfg, "test-token")

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)

		c := cookies[0]
		assert.Equal(t, "__Host-bot_gate", c.Name)
		assert.Empty(t, c.Domain, "__Host- cookies must not have a Domain attribute")
		assert.Equal(t, "/", c.Path)
		assert.Equal(t, 900, c.MaxAge)
		assert.True(t, c.HttpOnly)
		assert.True(t, c.Secure)
		assert.Equal(t, http.SameSiteLaxMode, c.SameSite)

		// Value should be timestamp:hmac format (64 hex chars for SHA256)
		assert.Regexp(t, `^\d+:[0-9a-f]{64}$`, c.Value)
	})

	t.Run("no __Host- prefix and sets Domain on localhost", func(t *testing.T) {
		w := httptest.NewRecorder()
		cfg := Config{CookieDomain: "localhost", SignupHMACSecret: "test-secret"}

		setBotGateCookie(w, cfg, "test-token")

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)
		assert.Equal(t, "bot_gate", cookies[0].Name)
		assert.Equal(t, "localhost", cookies[0].Domain)
		assert.False(t, cookies[0].Secure)
	})

	t.Run("cookie passes validation after minimum age", func(t *testing.T) {
		cfg := Config{CookieDomain: "localhost", SignupHMACSecret: "test-secret"}
		token := "test-token"

		req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", nil)
		req.AddCookie(validCookie(cfg, token, 5*time.Second))
		assert.NoError(t, validateBotGateCookie(req, cfg, token))
	})
}
