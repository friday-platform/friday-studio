package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	c := newReadinessClient("https")
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
	c := newReadinessClient("http")
	if c.Transport != nil {
		t.Errorf("http scheme should leave Transport nil, got %T", c.Transport)
	}
	c2 := newReadinessClient("")
	if c2.Transport != nil {
		t.Errorf("empty scheme should leave Transport nil, got %T", c2.Transport)
	}
}

// TestReadinessRunner_Http200FlipsReady covers the happy path: a 200
// response makes the cache derive the service as healthy on the next
// Update tick. We assert via Snapshot (the public contract) rather
// than poking at customReady directly — same path the SSE handler
// and tray bucket use.
func TestReadinessRunner_Http200FlipsReady(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(runningReady("happy"))) // Seed: status=starting.
	r := readinessRunnerFromURL("happy", srv.URL+"/health", "http", cache, &fakeRestarter{})

	r.tick(context.Background())
	// runHealthPoll re-derives every 500ms in production; reproduce
	// that explicit cycle so Snapshot reflects the post-tick state.
	cache.Update(makeStates(runningReady("happy")))

	assertSnapshotStatus(t, cache, "happy", statusHealthy)
	if r.consecutiveFail != 0 {
		t.Errorf("consecutiveFail = %d, want 0", r.consecutiveFail)
	}
}

// TestReadinessRunner_Http500CountsFailure pins the failure path.
// 500 must count as a failure (bumps the counter, status stays
// starting) but must NOT trigger a restart until threshold is
// breached. We seed a prior-healthy state to make the negative-flip
// observable via Snapshot — same observation surface real consumers
// (tray, SSE) read from.
func TestReadinessRunner_Http500CountsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.SetReady("sad", true)
	cache.Update(makeStates(runningReady("sad"))) // Seed: status=healthy.
	assertSnapshotStatus(t, cache, "sad", statusHealthy)
	rt := &fakeRestarter{}
	r := readinessRunnerFromURL("sad", srv.URL+"/health", "http", cache, rt)

	r.tick(context.Background())
	cache.Update(makeStates(runningReady("sad"))) // production-order re-derive

	assertSnapshotStatus(t, cache, "sad", statusStarting)
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

// TestReadinessRunner_RestartCapStopsRequests pins the per-runner
// cap on launcher-driven restarts. process-compose's own MaxRestarts
// gates its in-band restart loop but does NOT consult
// ProjectRunner.RestartProcess (see process-compose's
// project_runner.go:doRestart), so without this cap a wedged service
// (port bound, /health hangs) would be bounced every ~62s for the
// lifetime of the launcher. The runner keeps probing past the cap —
// that's by design so the cache stays accurate if the service ever
// recovers — but it stops issuing restart requests.
func TestReadinessRunner_RestartCapStopsRequests(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	rt := &fakeRestarter{}
	r := readinessRunnerFromURL("wedged", srv.URL+"/health", "http", cache, rt)
	// Tighten knobs so the test exercises the cap quickly.
	r.failureMax = 2
	r.restartMax = 3

	// Issue restartMax restarts. failureMax=2 ticks per cycle.
	for cycle := 0; cycle < r.restartMax; cycle++ {
		r.tick(context.Background())
		r.tick(context.Background())
	}
	if got := rt.calls.Load(); int(got) != r.restartMax {
		t.Fatalf("RestartProcess calls = %d, want %d (one per cycle until cap)", got, r.restartMax)
	}

	// Drive several MORE failure cycles. RestartProcess must NOT be
	// called again — that's the regression guard.
	for cycle := 0; cycle < 5; cycle++ {
		r.tick(context.Background())
		r.tick(context.Background())
	}
	if got := rt.calls.Load(); int(got) != r.restartMax {
		t.Errorf("RestartProcess calls = %d after %d post-cap cycles, want %d (cap not enforced)",
			got, 5, r.restartMax)
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
// success. Pins the *whole* hot path against a real TLS handshake
// and asserts via Snapshot — the public contract real consumers read.
func TestReadinessRunner_HttpsTalksToTlsServer(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(runningReady("tls")))
	r := readinessRunnerFromURL("tls", srv.URL+"/health", "https", cache, &fakeRestarter{})

	r.tick(context.Background())
	cache.Update(makeStates(runningReady("tls")))

	assertSnapshotStatus(t, cache, "tls", statusHealthy)
}

// assertSnapshotStatus is the public-API verification helper. We
// deliberately go through Snapshot rather than peeking at
// cache.customReady — the tray bucket, SSE handler, and installer UI
// all consume Snapshot, so a regression that updated customReady but
// stopped propagating to Snapshot would slip past private-map peeks.
func assertSnapshotStatus(t *testing.T, c *HealthCache, name, want string) {
	t.Helper()
	got, _, _ := c.Snapshot()
	for _, s := range got {
		if s.Name == name {
			if s.Status != want {
				t.Errorf("Snapshot status for %q = %q, want %q", name, s.Status, want)
			}
			return
		}
	}
	t.Fatalf("snapshot did not contain %q; got %+v", name, got)
}

// TestReadinessRunner_HttpsRejectsWhenSkipVerifyDisabled is the
// symmetric guard, routed through the SAME constructor production
// uses. Toggling readinessTLSConfig.InsecureSkipVerify off should
// make the readiness probe fail against our self-signed loopback
// listener — pin that so a future refactor that "tightens" the TLS
// config without realising loopback-readiness depends on the skip
// gets caught at test time, not in QA.
//
// The previous form of this test bypassed newReadinessClient entirely
// and hand-built a default-transport client — that tests stdlib
// behavior, not the singleton's wiring. The mutation-with-cleanup
// shape below actually exercises production code.
func TestReadinessRunner_HttpsRejectsWhenSkipVerifyDisabled(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	prev := readinessTLSConfig.InsecureSkipVerify
	readinessTLSConfig.InsecureSkipVerify = false
	t.Cleanup(func() { readinessTLSConfig.InsecureSkipVerify = prev })

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	// Seed a running service so deriveStatus has something to walk.
	cache.Update(makeStates(runningReady("strict")))

	// scheme="https" routes through newReadinessClient → reads the
	// (now-mutated) readinessTLSConfig — same path production uses.
	r := readinessRunnerFromURL("strict", srv.URL+"/health", "https", cache, &fakeRestarter{})

	r.tick(context.Background())
	// Re-derive status after the probe tick; production hits this on
	// the next runHealthPoll cycle.
	cache.Update(makeStates(runningReady("strict")))

	got, _, _ := cache.Snapshot()
	if len(got) == 0 || got[0].Name != "strict" {
		t.Fatalf("snapshot didn't contain 'strict': %+v", got)
	}
	if got[0].Status == statusHealthy {
		t.Error("status = healthy against TLS server when readinessTLSConfig.InsecureSkipVerify=false; regression in singleton wiring")
	}
}

// TestReadinessRunner_RunTicksAndCancels covers the goroutine loop
// itself — not just .tick() in isolation. Pins:
//   - the initialDelay gate before the first tick,
//   - the period-driven ticker afterwards,
//   - immediate exit on ctx cancellation (no leaked goroutine).
//
// A regression like "ticker not stopped on cancel" or "Run loops on
// time.After instead of a ticker" would show up here.
func TestReadinessRunner_RunTicksAndCancels(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	r := readinessRunnerFromURL("loop", srv.URL+"/health", "http", cache, &fakeRestarter{})
	r.initialDelay = 0
	r.period = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.Run(ctx)
		close(done)
	}()

	// Give the loop a window to fire several ticks. ~80ms = ~8
	// expected ticks with period=10ms; we want comfortably more than 1
	// to confirm the ticker (not just the initial tick) is running.
	time.Sleep(80 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Run did not return within 1s of ctx cancel — goroutine leak")
	}
	if got := hits.Load(); got < 3 {
		t.Errorf("server hit count = %d, want ≥3 (initial + ≥2 periodic) — ticker may not be firing", got)
	}
}

// TestStartReadinessRunners_FanoutAndCancel covers the boot-path fan-
// out from main.go. One goroutine per spec, all wired to the same
// ctx; cancelling the ctx must tear all of them down. Without this
// test a refactor that drops the goroutine launch (or shares the
// runner across specs) ships silently.
func TestStartReadinessRunners_FanoutAndCancel(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Extract host:port from the server URL so each spec can target it
	// via the spec's healthPort knob.
	parsed, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port := parsed.Port()
	specs := []processSpec{
		{name: "a", healthPort: port, healthPath: "/health", healthScheme: "http"},
		{name: "b", healthPort: port, healthPath: "/health", healthScheme: "http"},
	}

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // safety net if the test fails mid-flight

	// Override probe timings so the test runs in ~tens of ms instead
	// of 62s. The package-level constants are tuned for cold-start
	// tolerance, not test speed; we don't want to mutate them here.
	// Instead we time-bound the assertion below.
	startReadinessRunners(ctx, specs, cache, &fakeRestarter{})

	// Wait for at least one tick per spec to confirm fan-out.
	// startReadinessRunners uses the production initialDelay=2s
	// constant, so a 3s window is the minimum-safe wait. We could
	// shave this by parameterising initialDelay, but that's
	// over-engineering for one test.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if hits.Load() >= 2 { // both specs hit at least once
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got := hits.Load(); got < 2 {
		t.Fatalf("server hit count = %d after fan-out window; want ≥2 (one per spec)", got)
	}

	// Cancel and confirm hits stop increasing. Goroutine leak would
	// keep the counter climbing past the cancel deadline.
	cancel()
	at := hits.Load()
	time.Sleep(200 * time.Millisecond)
	if delta := hits.Load() - at; delta > 1 {
		t.Errorf("hits incremented by %d after ctx cancel; want ≤1 (one in-flight tick allowed)", delta)
	}
}

// readinessRunnerFromURL constructs a runner pointing at a fully formed
// URL (rather than rebuilding from scheme/port/path). Used by tests
// that want to point the runner at a httptest server.
func readinessRunnerFromURL(name, rawURL, scheme string, cache *HealthCache, sup restarter) *readinessRunner {
	return &readinessRunner{
		name:         name,
		url:          rawURL,
		client:       newReadinessClient(scheme),
		cache:        cache,
		sup:          sup,
		initialDelay: 0,
		period:       50 * time.Millisecond,
		failureMax:   probeFailureThreshold,
		// restartMax mirrors the production default so tests that
		// exercise the threshold path don't accidentally hit the cap
		// on their first attempt. Cap-specific tests override locally.
		restartMax: supervisedMaxRestarts,
	}
}
