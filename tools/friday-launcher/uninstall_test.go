package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// withFakeHealthServer points the uninstall HTTP client at a test
// server bound to a randomly-allocated port. Callers replace the
// healthServerAddr global for the test's duration via the
// healthServerAddrOverride var.
func withFakeHealthServer(t *testing.T, h http.Handler) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	addr := strings.TrimPrefix(srv.URL, "http://")
	orig := healthServerAddrOverride
	t.Cleanup(func() { healthServerAddrOverride = orig })
	healthServerAddrOverride = addr
}

// TestHttpShutdownLauncher_202Accepted is the happy-path: handler
// returns 202, our caller treats it as "shutdown accepted, poll
// for pid removal" → returns nil so runUninstall doesn't fall
// through to SIGTERM.
func TestHttpShutdownLauncher_202Accepted(t *testing.T) {
	withFakeHealthServer(t, http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/launcher-shutdown" {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(http.StatusAccepted)
		}))

	if err := httpShutdownLauncher(); err != nil {
		t.Errorf("expected nil for 202, got %v", err)
	}
}

// TestHttpShutdownLauncher_409Conflict: launcher already shutting
// down. From the caller's perspective this is identical to 202 —
// poll launcher.pid for removal.
func TestHttpShutdownLauncher_409Conflict(t *testing.T) {
	withFakeHealthServer(t, http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
		}))

	if err := httpShutdownLauncher(); err != nil {
		t.Errorf("expected nil for 409, got %v", err)
	}
}

// TestHttpShutdownLauncher_5xxFallsThrough: a misbehaving launcher
// that 500s our POST is NOT "shutdown initiated". Caller falls
// through to SIGTERM.
func TestHttpShutdownLauncher_5xxFallsThrough(t *testing.T) {
	withFakeHealthServer(t, http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))

	err := httpShutdownLauncher()
	if err == nil {
		t.Fatal("expected error for 500, got nil")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error %q should mention status 500", err)
	}
}

// TestHttpShutdownLauncher_4xxFallsThrough: e.g. 404 from a server
// that's NOT a launcher (something else bound the port). Falls
// through to SIGTERM.
func TestHttpShutdownLauncher_4xxFallsThrough(t *testing.T) {
	withFakeHealthServer(t, http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			http.NotFound(w, nil)
		}))

	err := httpShutdownLauncher()
	if err == nil {
		t.Fatal("expected error for 404, got nil")
	}
}

// TestHttpShutdownLauncher_ConnRefusedFallsThrough: nothing's
// listening on the port (most common case during --uninstall —
// the launcher is already dead). Caller falls through to SIGTERM.
//
// We achieve this by pointing healthServerAddr at a port we
// reserve then close, so the next connect attempt gets
// "connection refused".
func TestHttpShutdownLauncher_ConnRefusedFallsThrough(t *testing.T) {
	withFakeHealthServer(t, http.HandlerFunc(nil))
	// Override addr to a port that has no listener so the
	// connection attempt gets refused.
	healthServerAddrOverride = "127.0.0.1:1"

	err := httpShutdownLauncher()
	if err == nil {
		t.Fatal("expected error for conn-refused, got nil")
	}
}

// TestHttpShutdownLauncher_TimeoutFallsThrough: a hung launcher
// that accepts the connection but never writes headers. The
// client timeout fires; caller falls through to SIGTERM.
//
// We override the package-level httpShutdownTimeout so the test
// finishes in well under a second — a real 5s wait would slow
// `go test` for everyone. The handler blocks until the test's
// Cleanup closes the server.
func TestHttpShutdownLauncher_TimeoutFallsThrough(t *testing.T) {
	// Block the handler until the server closes. The client should
	// hit our shortened timeout long before this fires.
	hang := make(chan struct{})
	t.Cleanup(func() { close(hang) })
	withFakeHealthServer(t, http.HandlerFunc(
		func(_ http.ResponseWriter, r *http.Request) {
			select {
			case <-hang:
			case <-r.Context().Done():
			}
		}))

	orig := httpShutdownTimeout
	t.Cleanup(func() { httpShutdownTimeout = orig })
	httpShutdownTimeout = 100 * time.Millisecond

	start := time.Now()
	err := httpShutdownLauncher()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	// net/http surfaces the timeout via the canonical "deadline
	// exceeded" sentinel in the wrapped chain; "Client.Timeout
	// exceeded" appears for client.Timeout-driven cancellations.
	msg := err.Error()
	if !strings.Contains(msg, "deadline exceeded") &&
		!strings.Contains(msg, "Timeout") &&
		!strings.Contains(msg, "timeout") {
		t.Errorf("error %q should mention timeout/deadline", err)
	}
	// Sanity: we shouldn't have waited the full 5s default.
	if elapsed > 2*time.Second {
		t.Errorf("client waited %v; httpShutdownTimeout override didn't apply", elapsed)
	}
}
