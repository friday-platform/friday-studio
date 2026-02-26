package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mlSessionCookie(cfg Config, token string) *http.Cookie {
	mac := mlSessionMAC(cfg.SignupHMACSecret, token)
	return &http.Cookie{
		Name:  mlSessionCookieName(cfg.CookieDomain),
		Value: mac,
	}
}

func TestValidateMLSessionCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret-key",
	}
	cookieName := mlSessionCookieName(cfg.CookieDomain)
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
			name:    "wrong HMAC signature",
			cookie:  &http.Cookie{Name: cookieName, Value: "deadbeef"},
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name:    "wrong token binding",
			cookie:  mlSessionCookie(cfg, "different-token"),
			token:   testToken,
			wantErr: "invalid",
		},
		{
			name:   "valid cookie",
			cookie: mlSessionCookie(cfg, testToken),
			token:  testToken,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", nil)
			if tt.cookie != nil {
				req.AddCookie(tt.cookie)
			}

			err := validateMLSessionCookie(req, cfg, tt.token)

			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSetMLSessionCookie(t *testing.T) {
	t.Run("sets cookie with __Host- prefix and no Domain", func(t *testing.T) {
		w := httptest.NewRecorder()
		cfg := Config{CookieDomain: "friday.ai", SignupHMACSecret: "test-secret"}

		setMLSessionCookie(w, cfg, "test-token")

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)

		c := cookies[0]
		assert.Equal(t, "__Host-ml_session", c.Name)
		assert.Empty(t, c.Domain, "__Host- cookies must not have a Domain attribute")
		assert.Equal(t, "/", c.Path)
		assert.Equal(t, 900, c.MaxAge)
		assert.True(t, c.HttpOnly)
		assert.True(t, c.Secure)
		assert.Equal(t, http.SameSiteLaxMode, c.SameSite)

		// Value should be 64 hex chars (SHA256 HMAC)
		assert.Regexp(t, `^[0-9a-f]{64}$`, c.Value)
	})

	t.Run("no __Host- prefix and sets Domain on localhost", func(t *testing.T) {
		w := httptest.NewRecorder()
		cfg := Config{CookieDomain: "localhost", SignupHMACSecret: "test-secret"}

		setMLSessionCookie(w, cfg, "test-token")

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)
		assert.Equal(t, "ml_session", cookies[0].Name)
		assert.Equal(t, "localhost", cookies[0].Domain)
		assert.False(t, cookies[0].Secure)
	})

	t.Run("set then validate round-trip", func(t *testing.T) {
		cfg := Config{CookieDomain: "localhost", SignupHMACSecret: "test-secret"}
		token := "test-token"

		w := httptest.NewRecorder()
		setMLSessionCookie(w, cfg, token)

		req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", nil)
		for _, c := range w.Result().Cookies() {
			req.AddCookie(c)
		}
		assert.NoError(t, validateMLSessionCookie(req, cfg, token))
	})

	t.Run("set then validate round-trip with __Host- prefix", func(t *testing.T) {
		cfg := Config{CookieDomain: "friday.ai", SignupHMACSecret: "test-secret"}
		token := "test-token"

		w := httptest.NewRecorder()
		setMLSessionCookie(w, cfg, token)

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)
		assert.Equal(t, "__Host-ml_session", cookies[0].Name)

		req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", nil)
		for _, c := range cookies {
			req.AddCookie(c)
		}
		assert.NoError(t, validateMLSessionCookie(req, cfg, token))
	})
}

func TestVerifyMagicLinkPost_RejectsMissingCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret",
	}
	ctx := context.WithValue(context.Background(), configContextKey, cfg)

	body := `{"otp":"some-token"}`
	req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	verifyMagicLinkPost(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "verification_failed")
}

func TestVerifyMagicLinkPost_RejectsWrongCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret",
	}
	ctx := context.WithValue(context.Background(), configContextKey, cfg)

	body := `{"otp":"some-token"}`
	req := httptest.NewRequest(http.MethodPost, "/magiclink/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "__Host-ml_session", Value: "wrong-mac"})
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	verifyMagicLinkPost(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "verification_failed")
}

func TestVerifyEmailSignupPost_RejectsMissingCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret",
	}
	ctx := context.WithValue(context.Background(), configContextKey, cfg)

	body := `{"token":"some-token"}`
	req := httptest.NewRequest(http.MethodPost, "/signup/email/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	verifyEmailSignupPost(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "verification_failed")
}

func TestVerifyEmailSignupPost_RejectsWrongCookie(t *testing.T) {
	cfg := Config{
		CookieDomain:     "friday.ai",
		SignupHMACSecret: "test-secret",
	}
	ctx := context.WithValue(context.Background(), configContextKey, cfg)

	body := `{"token":"some-token"}`
	req := httptest.NewRequest(http.MethodPost, "/signup/email/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "__Host-ml_session", Value: "wrong-mac"})
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	verifyEmailSignupPost(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "verification_failed")
}
