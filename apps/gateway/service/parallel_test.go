package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAllowedProxyHeaders(t *testing.T) {
	// Headers that should be forwarded
	allowed := []string{
		"Content-Type",
		"content-type",
		"Content-Length",
		"content-length",
		"Content-Encoding",
		"Accept",
		"Accept-Encoding",
		"Accept-Language",
		"User-Agent",
		"Cache-Control",
		"parallel-beta",
	}

	for _, h := range allowed {
		t.Run("allowed_"+h, func(t *testing.T) {
			assert.True(t, allowedProxyHeaders[strings.ToLower(h)], "expected %q to be allowed", h)
		})
	}

	// Headers that should be blocked (security-sensitive)
	blocked := []string{
		"Authorization",
		"Cookie",
		"Set-Cookie",
		"X-Api-Key",
		"X-Auth-Token",
		"Proxy-Authorization",
		"X-Forwarded-For",
		"X-Real-IP",
	}

	for _, h := range blocked {
		t.Run("blocked_"+h, func(t *testing.T) {
			assert.False(t, allowedProxyHeaders[strings.ToLower(h)], "expected %q to be blocked", h)
		})
	}
}

func TestAllowedCustomEmailHeaders(t *testing.T) {
	// Headers that should be allowed for email
	allowed := []string{
		"X-Atlas-User",
		"X-Atlas-Session",
		"X-Friday-Workspace",
		"X-Atlas-Agent",
		"X-Priority",
		"X-MSMail-Priority",
		"Importance",
	}

	for _, h := range allowed {
		t.Run("allowed_"+h, func(t *testing.T) {
			assert.True(t, allowedCustomHeaders[h], "expected %q to be allowed", h)
		})
	}

	// Headers that should be blocked
	blocked := []string{
		"X-Custom-Header",
		"From",
		"To",
		"Subject",
		"Bcc",
		"Reply-To",
	}

	for _, h := range blocked {
		t.Run("blocked_"+h, func(t *testing.T) {
			assert.False(t, allowedCustomHeaders[h], "expected %q to be blocked", h)
		})
	}
}
