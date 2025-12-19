package geoblock

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetClientIP(t *testing.T) {
	tests := []struct {
		name          string
		xForwardedFor string
		xRealIP       string
		remoteAddr    string
		expected      string
	}{
		{
			name:          "XFF single public IP",
			xForwardedFor: "203.0.113.50",
			expected:      "203.0.113.50",
		},
		{
			name:          "XFF multiple IPs uses first public",
			xForwardedFor: "203.0.113.50, 10.0.0.1, 192.168.1.1",
			expected:      "203.0.113.50",
		},
		{
			name:          "XFF skips leading private IPs to find public",
			xForwardedFor: "10.0.0.1, 192.168.1.1, 203.0.113.50",
			expected:      "203.0.113.50",
		},
		{
			name:          "XFF all private returns first entry",
			xForwardedFor: "10.0.0.1, 192.168.1.1",
			expected:      "10.0.0.1",
		},
		{
			name:       "X-Real-IP fallback when no XFF",
			xRealIP:    "203.0.113.50",
			expected:   "203.0.113.50",
		},
		{
			name:       "RemoteAddr with port extracts IP",
			remoteAddr: "203.0.113.50:12345",
			expected:   "203.0.113.50",
		},
		{
			name:       "RemoteAddr without port",
			remoteAddr: "203.0.113.50",
			expected:   "203.0.113.50",
		},
		{
			name:          "IPv6 address in XFF",
			xForwardedFor: "2001:db8::1",
			expected:      "2001:db8::1",
		},
		{
			name:       "IPv6 RemoteAddr with port",
			remoteAddr: "[2001:db8::1]:12345",
			expected:   "2001:db8::1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.xForwardedFor != "" {
				req.Header.Set("X-Forwarded-For", tt.xForwardedFor)
			}
			if tt.xRealIP != "" {
				req.Header.Set("X-Real-IP", tt.xRealIP)
			}
			if tt.remoteAddr != "" {
				req.RemoteAddr = tt.remoteAddr
			}

			got := getClientIP(req)
			if got != tt.expected {
				t.Errorf("getClientIP() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestIsPrivateIP(t *testing.T) {
	tests := []struct {
		ip       string
		expected bool
	}{
		// IPv4 loopback
		{"127.0.0.1", true},
		// IPv4 private ranges (RFC 1918)
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"192.168.255.255", true},
		// IPv4 link-local
		{"169.254.1.1", true},
		// IPv4 public
		{"8.8.8.8", false},
		{"203.0.113.50", false},
		{"1.1.1.1", false},
		// IPv6 loopback
		{"::1", true},
		// IPv6 link-local
		{"fe80::1", true},
		// IPv6 public (documentation range, but not private)
		{"2001:db8::1", false},
	}

	for _, tt := range tests {
		t.Run(tt.ip, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if ip == nil {
				t.Fatalf("failed to parse IP: %s", tt.ip)
			}
			got := isPrivateIP(ip)
			if got != tt.expected {
				t.Errorf("isPrivateIP(%s) = %v, want %v", tt.ip, got, tt.expected)
			}
		})
	}
}

// mockHandler records whether ServeHTTP was called.
type mockHandler struct {
	called bool
}

func (m *mockHandler) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	m.called = true
	rw.WriteHeader(http.StatusOK)
}

func TestGeoBlock_NilDatabase_FailsOpen(t *testing.T) {
	// When database fails to load, middleware allows all requests (fail-open).
	next := &mockHandler{}
	g := &GeoBlock{
		next:             next,
		db:               nil,
		allowedCountries: make(map[string]bool),
		allowUnknown:     true,
		name:             "test",
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.50:12345"
	rr := httptest.NewRecorder()

	g.ServeHTTP(rr, req)

	if !next.called {
		t.Error("expected next handler to be called when db is nil (fail-open)")
	}
}

func TestGeoBlock_BlockedResponse(t *testing.T) {
	// Test that blockRequest writes correct response.
	next := &mockHandler{}
	blockedHTML := []byte("<html><body>Blocked</body></html>")
	g := &GeoBlock{
		next:             next,
		db:               nil,
		allowedCountries: make(map[string]bool),
		allowUnknown:     true,
		blockedPage:      blockedHTML,
		name:             "test",
	}

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rr := httptest.NewRecorder()

	// Call blockRequest directly to test response formatting
	g.blockRequest(rr, req, "1.2.3.4", "CN")

	if rr.Code != http.StatusForbidden {
		t.Errorf("expected status %d, got %d", http.StatusForbidden, rr.Code)
	}

	if ct := rr.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("expected Content-Type 'text/html; charset=utf-8', got %q", ct)
	}

	if rr.Body.String() != string(blockedHTML) {
		t.Errorf("expected body %q, got %q", string(blockedHTML), rr.Body.String())
	}
}

func TestCreateConfig(t *testing.T) {
	config := CreateConfig()

	if config == nil {
		t.Fatal("CreateConfig returned nil")
	}

	if config.UnknownCountryAction != "allow" {
		t.Errorf("expected default UnknownCountryAction 'allow', got %q", config.UnknownCountryAction)
	}

	if config.DatabasePath != "" {
		t.Errorf("expected default DatabasePath empty, got %q", config.DatabasePath)
	}

	if len(config.AllowedCountries) != 0 {
		t.Errorf("expected default AllowedCountries empty, got %v", config.AllowedCountries)
	}
}

func TestLogEntry_Chaining(t *testing.T) {
	// Test that log entry builder methods return the same pointer for chaining.
	entry := logEntry("info", "test message", "test-middleware")

	result := entry.
		withClientIP("1.2.3.4").
		withCountryCode("US").
		withError(nil)

	if result != entry {
		t.Error("expected builder methods to return same pointer for chaining")
	}

	if entry.ClientIP != "1.2.3.4" {
		t.Errorf("expected ClientIP '1.2.3.4', got %q", entry.ClientIP)
	}

	if entry.CountryCode != "US" {
		t.Errorf("expected CountryCode 'US', got %q", entry.CountryCode)
	}
}

func TestGeoBlock_Close(t *testing.T) {
	// Test Close() with nil db returns nil error.
	g := &GeoBlock{db: nil}
	if err := g.Close(); err != nil {
		t.Errorf("Close() with nil db returned error: %v", err)
	}
}
