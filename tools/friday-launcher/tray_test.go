package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// newTestSupervisor constructs a Supervisor without going through
// NewSupervisor — we don't have a process-compose project to feed
// it for unit tests. computeBucket only reads SupervisorExited and
// StartedAt, so a hand-rolled struct is enough.
func newTestSupervisor(startedAt time.Time, exited bool) *Supervisor {
	s := &Supervisor{startedAt: startedAt}
	if exited {
		s.supervisorExited.Store(true)
	}
	return s
}

// TestComputeBucket_ShuttingDownGrey: shutting_down trumps every
// other signal. Even if the cache says all-healthy and the
// supervisor is happy, the tray must render grey so the user gets
// "Stopping…" feedback during teardown.
func TestComputeBucket_ShuttingDownGrey(t *testing.T) {
	var sd atomic.Bool
	sd.Store(true)

	cache := NewHealthCache(&sd)
	cache.Update(makeStates(runningReady("a")))
	sup := newTestSupervisor(time.Now(), false)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketGrey {
		t.Errorf("computeBucket = %v, want grey", got)
	}
}

// TestComputeBucket_SupervisorExitedRed: SupervisorExited (the
// runner.Run() returned without us asking it to) is the strongest
// "something is wrong" signal short of shutdown. Red beats amber
// + green; only shuttingDown beats it.
func TestComputeBucket_SupervisorExitedRed(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(runningReady("a")))
	sup := newTestSupervisor(time.Now(), true)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketRed {
		t.Errorf("computeBucket = %v, want red", got)
	}
}

// TestComputeBucket_AllHealthyGreen: the happy path. Every cached
// service is healthy → green bucket. Decision #4 alignment: green
// means "wizard's checklist is fully ticked".
func TestComputeBucket_AllHealthyGreen(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		runningReady("b"),
		runningReady("c"),
	))
	sup := newTestSupervisor(time.Now(), false)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketGreen {
		t.Errorf("computeBucket = %v, want green", got)
	}
}

// TestComputeBucket_PendingDuringColdStartAmber: in the first 30s
// of the launcher's lifetime, even with services that haven't
// transitioned to healthy we render amber rather than red. Stops
// users from panicking at the cold-start scary red bucket while
// services genuinely need a few seconds.
func TestComputeBucket_PendingDuringColdStartAmber(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		failed("b", 5), // would be red post-grace
	))
	// startedAt = now → uptime is well within the 30s grace.
	sup := newTestSupervisor(time.Now(), false)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketAmber {
		t.Errorf("computeBucket = %v, want amber (cold-start grace)", got)
	}
}

// TestComputeBucket_FailedPastGraceRed: once the launcher has been
// up past bucketFailGraceWindow, a failed service flips the bucket
// red. The grace window is the only thing that suppressed red
// earlier; past it, the user needs to know something needs
// attention. Boundary uses +5s of slack so a slow CI runner
// preempting between Add() and time.Since() doesn't flip past →
// within and false-fail.
func TestComputeBucket_FailedPastGraceRed(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		failed("b", 5),
	))
	sup := newTestSupervisor(time.Now().Add(-(bucketFailGraceWindow + 5*time.Second)), false)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketRed {
		t.Errorf("computeBucket = %v, want red", got)
	}
}

// TestComputeBucket_NotReadyPastGraceAmber: services in 'starting'
// (Running but probe NotReady) past the cold-start grace stay
// amber, NOT red. We only flip red on terminal-failed, never on
// slow-but-eventually-healthy. Otherwise a slow Mac would see red
// bucket during normal startup.
func TestComputeBucket_NotReadyPastGraceAmber(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(runningNotReady("a")))
	sup := newTestSupervisor(time.Now().Add(-(bucketFailGraceWindow + 5*time.Second)), false)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketAmber {
		t.Errorf("computeBucket = %v, want amber (slow but not failed)", got)
	}
}

// TestComputeBucket_FailedDuringActiveRestartAmber: while a tray-
// initiated RestartAll is in flight, AnyFailed reflects the stop
// pass tearing children down — that's expected, not a real failure,
// so the bucket must NOT flip red. Otherwise the menubar shows
// " Error" for the few seconds children take to come back up,
// which is exactly the user-visible bug we're fixing here.
func TestComputeBucket_FailedDuringActiveRestartAmber(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		failed("b", 5),
	))
	// startedAt past the cold-start grace, so without restart-grace
	// this would render red. inRestart=true must override to amber.
	sup := newTestSupervisor(time.Now().Add(-(bucketFailGraceWindow + 5*time.Second)), false)
	sup.inRestart.Store(true)

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketAmber {
		t.Errorf("computeBucket = %v, want amber (active restart)", got)
	}
}

// TestComputeBucket_FailedWithinRestartGraceAmber: for the
// restartGraceWindow seconds AFTER RestartAll returns, AnyFailed
// stays amber too — process-compose flips children to running
// before readiness probes pass, so AnyFailed lingers briefly.
func TestComputeBucket_FailedWithinRestartGraceAmber(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		failed("b", 5),
	))
	sup := newTestSupervisor(time.Now().Add(-(bucketFailGraceWindow + 5*time.Second)), false)
	// Restart completed 5s ago → still inside the grace window.
	sup.lastRestartEndNano.Store(time.Now().Add(-5 * time.Second).UnixNano())

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketAmber {
		t.Errorf("computeBucket = %v, want amber (post-restart grace)", got)
	}
}

// TestComputeBucket_FailedAfterRestartGraceRed: once the post-
// restart grace expires, a still-failed service flips red as
// usual. The grace is forgiveness for transient stop+start churn,
// not a permanent suppression. Boundary uses +5s of slack so a
// slow CI runner preempting between Add() and time.Since() doesn't
// flip past → within-grace and false-fail.
func TestComputeBucket_FailedAfterRestartGraceRed(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.Update(makeStates(
		runningReady("a"),
		failed("b", 5),
	))
	sup := newTestSupervisor(time.Now().Add(-(bucketFailGraceWindow + 10*time.Second)), false)
	sup.lastRestartEndNano.Store(time.Now().Add(-(restartGraceWindow + 5*time.Second)).UnixNano())

	tc := newTrayController(sup, &sd, cache)
	if got := tc.computeBucket(); got != bucketRed {
		t.Errorf("computeBucket = %v, want red (grace expired)", got)
	}
}

// TestRestartGraceActive_NoRestartYet: before any RestartAll runs
// (lastRestartEndNano == 0), grace is inactive — otherwise every
// fresh launcher would silently swallow real failures forever.
func TestRestartGraceActive_NoRestartYet(t *testing.T) {
	sup := newTestSupervisor(time.Now(), false)
	if sup.RestartGraceActive() {
		t.Error("RestartGraceActive() = true with no restart yet, want false")
	}
}

// TestComputeBucket_NilCacheAmber: defensive — if computeBucket
// runs before the cache is wired (shouldn't happen post-onReady,
// but the goroutine ordering isn't deterministic), render amber
// rather than panicking on a nil deref.
func TestComputeBucket_NilCacheAmber(t *testing.T) {
	var sd atomic.Bool
	sup := newTestSupervisor(time.Now(), false)
	tc := &trayController{sup: sup, shuttingDown: &sd, healthCache: nil}
	if got := tc.computeBucket(); got != bucketAmber {
		t.Errorf("computeBucket(nil cache) = %v, want amber", got)
	}
}

// withBrowserGlobals snapshots and restores ALL package-level
// browser state (noBrowser, browserDisabled, openURLInBrowserOverride)
// so individual openBrowser tests don't depend on entry-state from
// sibling tests. Robust under `go test -shuffle=on` and tolerant
// of future test reorderings. Returns a counter the caller can read
// to verify call counts on the stub opener.
//
// `t.Parallel()` is still unsafe (these are package-globals), but
// the symmetric save+restore makes the failure mode obvious if
// anyone adds it later — every test starts from the same baseline.
func withBrowserGlobals(t *testing.T) *int {
	t.Helper()
	origNoBrowser := noBrowser
	origBrowserDisabled := browserDisabled
	origOpener := openURLInBrowserOverride
	t.Cleanup(func() {
		noBrowser = origNoBrowser
		browserDisabled = origBrowserDisabled
		openURLInBrowserOverride = origOpener
	})
	calls := 0
	openURLInBrowserOverride = func(string) error {
		calls++
		return nil
	}
	return &calls
}

// TestOpenBrowser_NoBrowserSuppressesFirstHealthyOnly verifies the
// Stack 1.0 semantic refinement. Tray-click and second-instance
// wake reasons must still trigger openBrowser even when --no-browser
// is set. Only "first healthy" gets suppressed.
func TestOpenBrowser_NoBrowserSuppressesFirstHealthyOnly(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_BROWSER_DISABLED", "")
	calls := withBrowserGlobals(t)
	noBrowser = true
	browserDisabled = false

	tc := &trayController{}

	tc.openBrowser("first healthy")
	if *calls != 0 {
		t.Errorf("first-healthy + --no-browser: calls = %d, want 0", *calls)
	}
	tc.openBrowser("user click")
	if *calls != 1 {
		t.Errorf("user-click + --no-browser: calls = %d, want 1", *calls)
	}
	tc.openBrowser("second-instance wake")
	if *calls != 2 {
		t.Errorf("wake + --no-browser: calls = %d, want 2", *calls)
	}
}

// TestOpenBrowser_BrowserDisabledOverride confirms the test-only
// env-var path absolutely suppresses every openBrowser call. Used
// by integration tests that exercise tray-click / wake paths but
// don't want to pop tabs on the developer's machine.
func TestOpenBrowser_BrowserDisabledOverride(t *testing.T) {
	calls := withBrowserGlobals(t)
	browserDisabled = true

	tc := &trayController{}
	for _, reason := range []string{
		"first healthy", "user click", "second-instance wake",
	} {
		tc.openBrowser(reason)
	}
	if *calls != 0 {
		t.Errorf("browserDisabled: calls = %d, want 0", *calls)
	}
}
