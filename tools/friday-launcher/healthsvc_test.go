package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/f1bonacc1/process-compose/src/types"
	"github.com/go-chi/chi/v5"
)

func makeStates(states ...types.ProcessState) *types.ProcessesState {
	return &types.ProcessesState{States: states}
}

func runningReady(name string) types.ProcessState {
	return types.ProcessState{
		Name:           name,
		Status:         types.ProcessStateRunning,
		Health:         types.ProcessHealthReady,
		HasHealthProbe: true,
	}
}

func runningNotReady(name string) types.ProcessState {
	return types.ProcessState{
		Name:           name,
		Status:         types.ProcessStateRunning,
		Health:         types.ProcessHealthNotReady,
		HasHealthProbe: true,
	}
}

func pending(name string) types.ProcessState {
	return types.ProcessState{Name: name, Status: types.ProcessStatePending}
}

func failed(name string, restarts int) types.ProcessState {
	return types.ProcessState{
		Name:     name,
		Status:   types.ProcessStateError,
		Restarts: restarts,
	}
}

// TestDeriveStatus_Running confirms the Running+Ready / Running+NotReady
// → healthy / starting mapping. The wizard's checklist depends on
// this — a service with no health probe (e.g. a future addition with
// HasHealthProbe=false) treats Running as immediately healthy so it
// can never get stuck in 'starting'.
func TestDeriveStatus_Running(t *testing.T) {
	cases := []struct {
		name string
		ps   types.ProcessState
		want string
	}{
		{
			"running ready",
			runningReady("playground"),
			statusHealthy,
		},
		{
			"running not ready",
			runningNotReady("playground"),
			statusStarting,
		},
		{
			"running no probe",
			types.ProcessState{Name: "x", Status: types.ProcessStateRunning},
			statusHealthy,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := deriveStatus(c.ps); got != c.want {
				t.Errorf("deriveStatus(%+v) = %q, want %q", c.ps, got, c.want)
			}
		})
	}
}

// TestDeriveStatus_Pending covers Pending / Disabled / Scheduled,
// which all collapse to our single 'pending' state. No further
// distinction is exposed to consumers.
func TestDeriveStatus_Pending(t *testing.T) {
	cases := []string{
		types.ProcessStatePending,
		types.ProcessStateDisabled,
		types.ProcessStateScheduled,
	}
	for _, status := range cases {
		t.Run(status, func(t *testing.T) {
			ps := types.ProcessState{Name: "x", Status: status}
			if got := deriveStatus(ps); got != statusPending {
				t.Errorf("deriveStatus(Status=%s) = %q, want %q", status, got, statusPending)
			}
		})
	}
}

// TestDeriveStatus_FailedTerminal verifies that a service with
// Restarts >= 5 (MaxRestarts) and Status=Error is reported as
// 'failed' (terminal). Below MaxRestarts it's still 'starting' so
// the wizard renders the in-progress restart cycle as amber rather
// than red.
func TestDeriveStatus_FailedTerminal(t *testing.T) {
	if got := deriveStatus(failed("x", 4)); got != statusStarting {
		t.Errorf("Restarts=4 should still be starting, got %q", got)
	}
	if got := deriveStatus(failed("x", 5)); got != statusFailed {
		t.Errorf("Restarts=5 should be failed, got %q", got)
	}
	if got := deriveStatus(failed("x", 99)); got != statusFailed {
		t.Errorf("Restarts=99 should be failed, got %q", got)
	}
}

// TestDeriveStatus_TransientStarting covers Launching / Launched /
// Restarting / Terminating — all transient states the wizard renders
// with a spinner (amber). Specifically Restarting must NOT collapse
// to failed, otherwise a single SIGKILL+restart turns the row red.
func TestDeriveStatus_TransientStarting(t *testing.T) {
	for _, status := range []string{
		types.ProcessStateLaunching,
		types.ProcessStateLaunched,
		types.ProcessStateRestarting,
		types.ProcessStateTerminating,
	} {
		t.Run(status, func(t *testing.T) {
			ps := types.ProcessState{Name: "x", Status: status}
			if got := deriveStatus(ps); got != statusStarting {
				t.Errorf("deriveStatus(Status=%s) = %q, want starting", status, got)
			}
		})
	}
}

// TestHealthCache_FirstUpdateSeedsServices ensures the first Update
// call populates the cache from an empty state, preserving snapshot
// order, and that all services start with SinceSecs=0 (rounded
// down — same observation tick).
func TestHealthCache_FirstUpdateSeedsServices(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(
		runningReady("nats-server"),
		pending("friday"),
		runningNotReady("link"),
	))

	got, _, _ := c.Snapshot()
	if len(got) != 3 {
		t.Fatalf("snapshot len = %d, want 3", len(got))
	}
	if got[0].Name != "nats-server" || got[0].Status != statusHealthy {
		t.Errorf("[0] = %+v, want nats-server healthy", got[0])
	}
	if got[1].Name != "friday" || got[1].Status != statusPending {
		t.Errorf("[1] = %+v, want friday pending", got[1])
	}
	if got[2].Name != "link" || got[2].Status != statusStarting {
		t.Errorf("[2] = %+v, want link starting", got[2])
	}
	for _, s := range got {
		if s.SinceSecs != 0 {
			t.Errorf("%s SinceSecs = %d, want 0 on first observation", s.Name, s.SinceSecs)
		}
	}
}

// TestHealthCache_TransitionUpdatesSinceSecs verifies that when a
// service's status changes between two Update calls, its
// transitionAt resets so SinceSecs counts from the transition,
// not from the cache's first observation.
func TestHealthCache_TransitionUpdatesSinceSecs(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	// First observation — service is starting.
	c.Update(makeStates(runningNotReady("playground")))

	// Sleep enough for SinceSecs to roll past 0 if the service
	// stayed in starting. Then transition to healthy.
	time.Sleep(1100 * time.Millisecond)

	// If we re-Update with the SAME state, transitionAt must NOT
	// move — SinceSecs reflects how long it's been starting.
	c.Update(makeStates(runningNotReady("playground")))
	got, _, _ := c.Snapshot()
	if got[0].SinceSecs < 1 {
		t.Fatalf("expected SinceSecs >= 1 for unchanged status, got %d", got[0].SinceSecs)
	}

	// Now transition. SinceSecs must reset to 0.
	c.Update(makeStates(runningReady("playground")))
	got, _, _ = c.Snapshot()
	if got[0].Status != statusHealthy {
		t.Fatalf("status = %q, want healthy", got[0].Status)
	}
	if got[0].SinceSecs != 0 {
		t.Errorf("SinceSecs = %d after transition, want 0", got[0].SinceSecs)
	}
}

// TestHealthCache_SnapshotIsolated ensures Snapshot returns a copy
// that can be mutated by the caller without affecting subsequent
// snapshots. Specifically: HTTP handlers JSON-encode the slice
// outside the read lock; if the slice were shared, a second poll
// could mutate it mid-encode.
func TestHealthCache_SnapshotIsolated(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningReady("a"), runningReady("b")))

	first, _, _ := c.Snapshot()
	first[0].Status = "MUTATED"

	second, _, _ := c.Snapshot()
	if second[0].Status != statusHealthy {
		t.Errorf("snapshot mutation leaked; got %q", second[0].Status)
	}
}

// TestHealthCache_AllHealthyAndAnyFailed exercises the predicates
// the tray bucket logic depends on. Edge cases: empty cache returns
// false for AllHealthy (no first Update yet); single failed service
// flips AnyFailed regardless of others.
func TestHealthCache_AllHealthyAndAnyFailed(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	if c.AllHealthy() {
		t.Error("empty cache should not be AllHealthy")
	}
	if c.AnyFailed() {
		t.Error("empty cache should not have AnyFailed")
	}

	c.Update(makeStates(runningReady("a"), runningReady("b")))
	if !c.AllHealthy() {
		t.Error("two-healthy cache should be AllHealthy")
	}
	if c.AnyFailed() {
		t.Error("two-healthy cache should not have AnyFailed")
	}

	c.Update(makeStates(runningReady("a"), runningNotReady("b")))
	if c.AllHealthy() {
		t.Error("one-not-ready cache should not be AllHealthy")
	}

	c.Update(makeStates(runningReady("a"), failed("b", 5)))
	if c.AllHealthy() {
		t.Error("one-failed cache should not be AllHealthy")
	}
	if !c.AnyFailed() {
		t.Error("one-failed cache should report AnyFailed")
	}
}

// TestHealthCache_ShuttingDownPropagates verifies Snapshot returns
// the shutdown flag from the global atomic the cache holds a
// pointer to. Decision #33 alignment: HealthCache doesn't own
// the flag; the same atomic the tray reads.
func TestHealthCache_ShuttingDownPropagates(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningReady("a")))

	_, _, sawShuttingDown := c.Snapshot()
	if sawShuttingDown {
		t.Error("shutting_down should be false initially")
	}

	sd.Store(true)
	_, _, sawShuttingDown = c.Snapshot()
	if !sawShuttingDown {
		t.Error("shutting_down should be true after sd.Store(true)")
	}
}

// TestHealthCache_Subscribe_NotifyOnChange asserts the SSE fan-out
// fires when a status transitions, and does NOT fire when Update is
// called with identical states. Saves bandwidth on the SSE wire and
// avoids spurious wizard re-renders.
func TestHealthCache_Subscribe_NotifyOnChange(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	ch := c.Subscribe()
	defer c.Unsubscribe(ch)

	// First Update populates the cache — counts as a change for
	// every initial entry. We expect at least one tick.
	c.Update(makeStates(runningNotReady("a")))
	select {
	case <-ch:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("first Update should have fired a tick")
	}

	// Repeating the same Update must NOT tick.
	c.Update(makeStates(runningNotReady("a")))
	select {
	case <-ch:
		t.Error("identical Update should not have fired a tick")
	case <-time.After(50 * time.Millisecond):
	}

	// Transitioning fires a tick.
	c.Update(makeStates(runningReady("a")))
	select {
	case <-ch:
	case <-time.After(50 * time.Millisecond):
		t.Error("transition should have fired a tick")
	}
}

// TestHealthCache_Unsubscribe_ClosesChannel asserts that calling
// Unsubscribe closes the channel so any blocked reader returns
// immediately, and that calling Unsubscribe twice on the same
// channel is safe (idempotent — no double-close panic).
func TestHealthCache_Unsubscribe_ClosesChannel(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	ch := c.Subscribe()
	c.Unsubscribe(ch)
	if _, ok := <-ch; ok {
		t.Error("expected closed channel after Unsubscribe")
	}
	// Second call should be a no-op (channel already removed).
	c.Unsubscribe(ch)
}

// TestHealthCache_Subscribe_SlowSubscriber asserts the writer never
// blocks on a slow consumer. We register a subscriber that never
// reads; subsequent Updates must still complete promptly.
func TestHealthCache_Subscribe_SlowSubscriber(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	slow := c.Subscribe()
	defer c.Unsubscribe(slow)
	// Don't drain `slow`. Force the writer to either coalesce or
	// drop ticks but never block.

	done := make(chan struct{})
	go func() {
		// 100 transitions back and forth. If the writer were
		// blocking on the slow subscriber's full buffer, this
		// would never complete.
		for i := range 100 {
			if i%2 == 0 {
				c.Update(makeStates(runningNotReady("a")))
			} else {
				c.Update(makeStates(runningReady("a")))
			}
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("writer blocked on slow subscriber")
	}
}

// TestHealthCache_Subscribe_SlowDoesNotStarveFast asserts the
// fan-out invariant: a slow subscriber that never drains its buffer
// does NOT prevent a fast subscriber from receiving ticks. The
// non-blocking-send loop in notifySubscribers is what protects this;
// a regression that uses blocking sends (or a single shared channel)
// would stall the fast consumer behind the slow one.
//
// "Fast" gets at least one tick within a short bound while "slow"
// is held idle the whole time.
func TestHealthCache_Subscribe_SlowDoesNotStarveFast(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	slow := c.Subscribe()
	defer c.Unsubscribe(slow)
	fast := c.Subscribe()
	defer c.Unsubscribe(fast)
	// Fill slow's buffer (capacity 1) so subsequent notifies hit
	// the non-blocking-send default branch on it.
	c.Update(makeStates(runningNotReady("a")))

	// Drive a transition; both subscribers' buffers should now be
	// full (slow had one queued already → coalesced; fast just got
	// the new one).
	c.Update(makeStates(runningReady("a")))

	// Fast must observe the tick within a short bound. If the
	// writer were blocked on slow, fast would never see this.
	select {
	case <-fast:
	case <-time.After(1 * time.Second):
		t.Fatal("fast subscriber starved by slow subscriber")
	}

	// Subsequent updates must continue to land on fast even though
	// slow remains undrained — the writer must keep iterating
	// through subscribers, not stop at the first blocked one.
	for i := range 10 {
		if i%2 == 0 {
			c.Update(makeStates(runningNotReady("a")))
		} else {
			c.Update(makeStates(runningReady("a")))
		}
		select {
		case <-fast:
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("fast subscriber missed tick %d (slow still undrained)", i)
		}
	}
}

// TestHealthCache_Subscribe_RejectsBeyondCap verifies Subscribe
// returns nil once maxSubscribers is reached. Loopback-only
// mitigates the threat surface but a misbehaving local client
// could otherwise pin RAM by opening thousands of SSE streams.
func TestHealthCache_Subscribe_RejectsBeyondCap(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	subs := make([]chan struct{}, 0, maxSubscribers)
	for range maxSubscribers {
		ch := c.Subscribe()
		if ch == nil {
			t.Fatal("Subscribe returned nil before reaching cap")
		}
		subs = append(subs, ch)
	}
	defer func() {
		for _, ch := range subs {
			c.Unsubscribe(ch)
		}
	}()
	if c.Subscribe() != nil {
		t.Errorf("Subscribe at cap+1 should return nil, got non-nil")
	}
}

// TestHealthCache_UptimeSecsMonotonic confirms UptimeSecs and the
// uptime field of Snapshot are coherent with cache age. Used by
// the tray bucket to enforce the 30s cold-start grace.
func TestHealthCache_UptimeSecsMonotonic(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	if got := c.UptimeSecs(); got != 0 {
		t.Errorf("fresh cache UptimeSecs = %d, want 0", got)
	}
	time.Sleep(1100 * time.Millisecond)
	if got := c.UptimeSecs(); got < 1 {
		t.Errorf("UptimeSecs after 1.1s = %d, want >= 1", got)
	}
	_, snapshotUptime, _ := c.Snapshot()
	if snapshotUptime < 1 {
		t.Errorf("Snapshot uptime = %d, want >= 1", snapshotUptime)
	}
}

// TestHandleHealth_OK exercises the happy path: GET returns 200,
// JSON body has all expected fields, all_healthy reflects the cache.
func TestHandleHealth_OK(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningReady("a"), runningReady("b")))

	req := httptest.NewRequest(http.MethodGet, "/api/launcher-health", nil)
	rec := httptest.NewRecorder()
	handleHealth(c)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.AllHealthy {
		t.Errorf("all_healthy = false, want true")
	}
	if body.ShuttingDown {
		t.Errorf("shutting_down = true, want false")
	}
	if len(body.Services) != 2 {
		t.Errorf("services len = %d, want 2", len(body.Services))
	}
}

// TestHandleHealth_ShuttingDownReturns503 confirms the 503 +
// shutting_down: true contract documented in v15 § cross-cutting.
// Polling clients use this transition to detect that shutdown is
// in progress.
func TestHandleHealth_ShuttingDownReturns503(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningReady("a")))
	sd.Store(true)

	req := httptest.NewRequest(http.MethodGet, "/api/launcher-health", nil)
	rec := httptest.NewRecorder()
	handleHealth(c)(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.ShuttingDown {
		t.Errorf("shutting_down = false, want true after sd.Store(true)")
	}
}

// TestHandleShutdown_FirstCall202 covers the happy path: cache flag
// is unset → 202 + Location header + body. The goroutine kick-off
// is observed via a counter (the perform stub increments).
func TestHandleShutdown_FirstCall202(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)

	called := make(chan string, 1)
	perform := func(reason string) {
		called <- reason
	}

	req := httptest.NewRequest(http.MethodPost, "/api/launcher-shutdown", nil)
	rec := httptest.NewRecorder()
	handleShutdown(c, perform)(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/api/launcher-health" {
		t.Errorf("Location = %q, want /api/launcher-health", loc)
	}
	select {
	case reason := <-called:
		if reason != "http:shutdown" {
			t.Errorf("perform called with %q, want http:shutdown", reason)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("perform was not invoked")
	}
}

// TestHandleShutdown_409WhenAlreadyShuttingDown asserts the 409
// Conflict path that signals "another caller already started this".
// Decision #33: the cache flag is the visibility probe; the actual
// CAS is owned by performShutdown's existing shutdownStarted gate.
func TestHandleShutdown_409WhenAlreadyShuttingDown(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	sd.Store(true)

	called := make(chan string, 1)
	perform := func(reason string) { called <- reason }

	req := httptest.NewRequest(http.MethodPost, "/api/launcher-shutdown", nil)
	rec := httptest.NewRecorder()
	handleShutdown(c, perform)(rec, req)

	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
	select {
	case reason := <-called:
		t.Errorf("perform should not be invoked on 409, was called with %q", reason)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestStartHealthServer_PortInUse pre-binds 5199 with a stub
// listener so startHealthServer's net.Listen call fails. We assert
// the wrapped error path so main.go has something to translate
// into the osascript dialog (Decision #28).
func TestStartHealthServer_PortInUse(t *testing.T) {
	preBind, err := net.Listen("tcp", healthServerAddr)
	if err != nil {
		t.Skipf("could not pre-bind %s, skipping: %v", healthServerAddr, err)
	}
	defer func() { _ = preBind.Close() }()

	var sd atomic.Bool
	c := NewHealthCache(&sd)
	srv, err := startHealthServer(c, func(string) {})
	if err == nil {
		_ = srv.Close()
		t.Fatal("expected bind error, got nil")
	}
	if !strings.Contains(err.Error(), "bind") ||
		!strings.Contains(err.Error(), healthServerAddr) {
		t.Errorf("error %q should mention bind + addr", err)
	}
}

// TestStartHealthServer_EndToEnd_GET binds on a different port (we
// can't depend on 5199 being free in CI), wires the cache + handler
// chain, and exercises GET /api/launcher-health over the network
// so chi routing + Content-Type negotiation are covered.
func TestStartHealthServer_EndToEnd_GET(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningReady("a")))

	r := chi.NewRouter()
	r.Get("/api/launcher-health", handleHealth(c))
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/launcher-health")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.AllHealthy {
		t.Errorf("all_healthy false, want true")
	}
}

// TestHealthStream_DeliversInitialAndTransition confirms the SSE
// handler emits an immediate initial snapshot AND fires a follow-up
// when a service transitions. Uses a real httptest.Server because
// httptest.ResponseRecorder doesn't speak streaming.
func TestHealthStream_DeliversInitialAndTransition(t *testing.T) {
	var sd atomic.Bool
	c := NewHealthCache(&sd)
	c.Update(makeStates(runningNotReady("playground")))

	r := chi.NewRouter()
	r.Get("/api/launcher-health/stream", handleHealthStream(c))
	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, srv.URL+"/api/launcher-health/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	rd := bufio.NewReader(resp.Body)
	first, err := readSSEEvent(rd, 1500*time.Millisecond)
	if err != nil {
		t.Fatalf("read first event: %v", err)
	}
	var firstBody healthResponse
	if err := json.Unmarshal([]byte(first), &firstBody); err != nil {
		t.Fatalf("first event decode: %v", err)
	}
	if firstBody.AllHealthy {
		t.Errorf("initial snapshot AllHealthy = true, want false (playground starting)")
	}

	// Transition. SSE consumer should receive a follow-up event
	// with all_healthy: true.
	c.Update(makeStates(runningReady("playground")))

	second, err := readSSEEvent(rd, 1500*time.Millisecond)
	if err != nil {
		t.Fatalf("read second event: %v", err)
	}
	var secondBody healthResponse
	if err := json.Unmarshal([]byte(second), &secondBody); err != nil {
		t.Fatalf("second event decode: %v", err)
	}
	if !secondBody.AllHealthy {
		t.Errorf("post-transition AllHealthy = false, want true")
	}
}

// readSSEEvent reads a single `data: ...` event from an SSE stream.
// Returns the JSON payload (without the data: prefix) or error on
// timeout / malformed event.
func readSSEEvent(rd *bufio.Reader, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return "", errors.New("sse read timeout")
		}
		line, err := rd.ReadString('\n')
		if err != nil {
			return "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// blank line terminates a partial event we haven't
			// captured; ignore and keep reading.
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			// Drain the trailing blank line that ends the event.
			_, _ = rd.ReadString('\n')
			return payload, nil
		}
	}
}
