package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRestarter records calls so tests can assert restart-on-threshold
// behavior without spinning up a real process-compose supervisor.
type fakeRestarter struct {
	calls atomic.Int32
	err   error
}

func (f *fakeRestarter) RestartProcess(_ string) error {
	f.calls.Add(1)
	return f.err
}

// TestReadinessTLSConfig_SkipsVerify pins the package-level
// readinessTLSConfig: InsecureSkipVerify must be true. The whole
// reason this file exists is to inject this single tls.Config into
// every https probe's http.Client, so a future refactor that flips
// this to false would silently re-introduce the bouncing-services
// regression on every install with valid s2s certs.
func TestReadinessTLSConfig_SkipsVerify(t *testing.T) {
	if readinessTLSConfig == nil {
		t.Fatal("readinessTLSConfig is nil")
	}
	if !readinessTLSConfig.InsecureSkipVerify {
		t.Error("readinessTLSConfig.InsecureSkipVerify = false; want true")
	}
}

// TestNewReadinessClient_HttpsUsesTLSConfig confirms the https path
// hands readinessTLSConfig to the client's transport. The full chain
// is what every https readinessRunner builds at boot:
// client.Transport.(*http.Transport).TLSClientConfig === readinessTLSConfig.
func TestNewReadinessClient_HttpsUsesTLSConfig(t *testing.T) {
	c := newReadinessClient("https", 2*time.Second)
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", c.Transport)
	}
	if tr.TLSClientConfig != readinessTLSConfig {
		t.Error("Transport.TLSClientConfig is not the package readinessTLSConfig")
	}
}

// TestNewReadinessClient_HttpReusesDefault confirms plain HTTP doesn't
// allocate a per-runner transport (Transport stays nil, so http.Client
// falls back to http.DefaultTransport).
func TestNewReadinessClient_HttpReusesDefault(t *testing.T) {
	c := newReadinessClient("http", 2*time.Second)
	if c.Transport != nil {
		t.Errorf("http scheme should leave Transport nil, got %T", c.Transport)
	}
	c2 := newReadinessClient("", 2*time.Second)
	if c2.Transport != nil {
		t.Errorf("empty scheme should leave Transport nil, got %T", c2.Transport)
	}
}

// TestReadinessRunner_Http200FlipsReady covers the happy path: the
// probe target answers 200, the runner reports ready=true to the
// cache, and the failure counter stays at zero.
func TestReadinessRunner_Http200FlipsReady(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	r := readinessRunnerFromURL("happy", srv.URL+"/health", "http", cache, &fakeRestarter{})

	r.tick(context.Background())

	cache.mu.RLock()
	ready := cache.customReady["happy"]
	cache.mu.RUnlock()
	if !ready {
		t.Error("expected customReady[happy]=true after 200 response")
	}
	if r.consecutiveFail != 0 {
		t.Errorf("consecutiveFail = %d, want 0", r.consecutiveFail)
	}
}

// TestReadinessRunner_Http500CountsFailure pins the failure path.
// 500 must count as a failure (bumps the counter, flips ready=false)
// but must NOT trigger a restart until threshold is breached.
func TestReadinessRunner_Http500CountsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.SetReady("sad", true) // Seed prior-ready so we can observe the flip.
	rt := &fakeRestarter{}
	r := readinessRunnerFromURL("sad", srv.URL+"/health", "http", cache, rt)

	r.tick(context.Background())

	cache.mu.RLock()
	ready := cache.customReady["sad"]
	cache.mu.RUnlock()
	if ready {
		t.Error("expected customReady[sad]=false after 500 response")
	}
	if r.consecutiveFail != 1 {
		t.Errorf("consecutiveFail = %d, want 1", r.consecutiveFail)
	}
	if got := rt.calls.Load(); got != 0 {
		t.Errorf("RestartProcess calls = %d, want 0 (below threshold)", got)
	}
}

// TestReadinessRunner_RestartOnThreshold pins the critical guarantee:
// after probeFailureThreshold consecutive failures the runner calls
// sup.RestartProcess and resets its counter so the post-restart
// cold-start window doesn't immediately fire a second restart.
func TestReadinessRunner_RestartOnThreshold(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	rt := &fakeRestarter{}
	r := readinessRunnerFromURL("stuck", srv.URL+"/health", "http", cache, rt)
	r.failureMax = 3 // Shorten for the test.

	// Below threshold: no restart.
	r.tick(context.Background())
	r.tick(context.Background())
	if rt.calls.Load() != 0 {
		t.Fatalf("RestartProcess fired below threshold (calls=%d)", rt.calls.Load())
	}

	// Third failure crosses threshold; counter resets to 0.
	r.tick(context.Background())
	if got := rt.calls.Load(); got != 1 {
		t.Errorf("RestartProcess calls = %d, want 1 at threshold", got)
	}
	if r.consecutiveFail != 0 {
		t.Errorf("consecutiveFail = %d after restart, want 0 (reset)", r.consecutiveFail)
	}

	// Next failure starts a fresh window; no immediate second restart.
	r.tick(context.Background())
	if got := rt.calls.Load(); got != 1 {
		t.Errorf("second RestartProcess fired prematurely (calls=%d, want 1)", got)
	}
}

// TestReadinessRunner_RecoveryClearsCounter verifies a single success
// after a string of failures wipes the failure counter — otherwise a
// flapping service would accumulate failures over the entire run and
// eventually trip the threshold from non-consecutive failures.
func TestReadinessRunner_RecoveryClearsCounter(t *testing.T) {
	var statusCode atomic.Int32
	statusCode.Store(http.StatusInternalServerError)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(statusCode.Load()))
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	rt := &fakeRestarter{}
	r := readinessRunnerFromURL("flap", srv.URL+"/health", "http", cache, rt)
	r.failureMax = 5

	r.tick(context.Background())
	r.tick(context.Background())
	if r.consecutiveFail != 2 {
		t.Fatalf("consecutiveFail = %d, want 2", r.consecutiveFail)
	}

	statusCode.Store(http.StatusOK)
	r.tick(context.Background())
	if r.consecutiveFail != 0 {
		t.Errorf("consecutiveFail = %d after recovery, want 0", r.consecutiveFail)
	}
}

// TestReadinessRunner_HttpsTalksToTlsServer end-to-end probes a
// httptest TLS server with a self-signed cert. Without
// readinessTLSConfig in the client's transport the default Go
// transport would reject this cert and the runner would never see a
// success. Pins the *whole* hot path against a real TLS handshake.
func TestReadinessRunner_HttpsTalksToTlsServer(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	r := readinessRunnerFromURL("tls", srv.URL+"/health", "https", cache, &fakeRestarter{})

	r.tick(context.Background())

	cache.mu.RLock()
	ready := cache.customReady["tls"]
	cache.mu.RUnlock()
	if !ready {
		t.Errorf("expected customReady[tls]=true against TLS server with readinessTLSConfig")
	}
}

// TestReadinessRunner_HttpsRejectsWithoutSkipVerify is the symmetric
// guard: if we forget to hand readinessTLSConfig to the client, the
// default transport fails the handshake. Pins this so a future
// refactor that quietly defaults to system trust gets caught.
func TestReadinessRunner_HttpsRejectsWithoutSkipVerify(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	r := readinessRunnerFromURL("strict", srv.URL+"/health", "http", cache, &fakeRestarter{})
	// Replace the http client with a default-transport one (no
	// readinessTLSConfig) and override the URL to point at the TLS
	// server. The runner then talks https through a non-TLS-aware
	// client and the handshake fails — exactly the bad refactor we
	// want to catch.
	r.url = srv.URL + "/health"
	r.client = &http.Client{Timeout: 2 * time.Second}

	r.tick(context.Background())

	cache.mu.RLock()
	ready := cache.customReady["strict"]
	cache.mu.RUnlock()
	if ready {
		t.Error("expected ready=false against TLS server WITHOUT readinessTLSConfig; got true (would mean handshake succeeded — regression)")
	}
}

// readinessRunnerFromURL constructs a runner pointing at a fully formed
// URL (rather than rebuilding from scheme/port/path). Used by tests
// that want to point the runner at a httptest server.
func readinessRunnerFromURL(name, rawURL, scheme string, cache *HealthCache, sup restarter) *readinessRunner {
	return &readinessRunner{
		name:         name,
		url:          rawURL,
		client:       newReadinessClient(scheme, 2*time.Second),
		cache:        cache,
		sup:          sup,
		initialDelay: 0,
		period:       50 * time.Millisecond,
		failureMax:   probeFailureThreshold,
	}
}
