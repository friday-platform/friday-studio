package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/friday-platform/friday-studio/tools/friday-launcher/diagnostics"
)

// withExportFn swaps the package-level exportFn for the duration of
// one test, restoring the prior value on cleanup. Same shape as
// withBrowserGlobals in tray_test.go — keeps the seam restoration
// honest under -shuffle=on.
func withExportFn(t *testing.T, fn func(diagnostics.ExportOptions) (string, error)) {
	t.Helper()
	orig := exportFn
	exportFn = fn
	t.Cleanup(func() { exportFn = orig })
}

// withRevealOverride swaps the reveal-in-Finder shell-out so tests
// don't pop Finder on the developer's machine. The returned counter
// captures how many times reveal was attempted.
func withRevealOverride(t *testing.T) *int {
	t.Helper()
	orig := revealInFileBrowserOverride
	calls := 0
	revealInFileBrowserOverride = func(string) error {
		calls++
		return nil
	}
	t.Cleanup(func() { revealInFileBrowserOverride = orig })
	return &calls
}

// TestDaemonAPIBaseURL_DefaultPortPlainHTTP confirms the helper falls
// back to http://localhost:8080 when neither FRIDAY_PORT_FRIDAY nor
// s2s certs are present. This is the boot-time default before the
// installer downloads the cert pair.
func TestDaemonAPIBaseURL_DefaultPortPlainHTTP(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())
	t.Setenv("FRIDAY_PORT_FRIDAY", "")

	got := daemonAPIBaseURL()
	want := "http://localhost:8080"
	if got != want {
		t.Errorf("daemonAPIBaseURL() = %q, want %q", got, want)
	}
}

// TestDaemonAPIBaseURL_HonorsPortOverride confirms FRIDAY_PORT_FRIDAY
// routes into the URL. Installs that move the daemon off 8080 (port
// collision with another local Friday) need this to work or the tray
// export silently calls the wrong endpoint.
func TestDaemonAPIBaseURL_HonorsPortOverride(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())
	t.Setenv("FRIDAY_PORT_FRIDAY", "18080")

	got := daemonAPIBaseURL()
	want := "http://localhost:18080"
	if got != want {
		t.Errorf("daemonAPIBaseURL() = %q, want %q", got, want)
	}
}

// TestServiceHealthy_OnlyHealthyCountsTrue confirms the per-service
// helper returns true only for services whose status is "healthy".
// Pending/starting/failed all return false. Unknown names return
// false (defensive — caller doesn't have to know which services
// exist).
func TestServiceHealthy_OnlyHealthyCountsTrue(t *testing.T) {
	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	cache.SetReady("friday", true)
	cache.Update(makeStates(
		runningReady("friday"),
		runningNotReady("link"),
		failed("playground", 5),
	))

	cases := []struct {
		name string
		want bool
	}{
		{"friday", true},
		{"link", false},
		{"playground", false},
		{"does-not-exist", false},
	}
	for _, c := range cases {
		if got := cache.ServiceHealthy(c.name); got != c.want {
			t.Errorf("ServiceHealthy(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestStartExport_CASGuardSwallowsSecondClick is the load-bearing
// concurrency test. The two clicks run serially on this goroutine: the
// first startExport CAS's exporting false→true and spawns runExport; the
// second finds the slot taken and returns synchronously — the CAS fires
// before any goroutine spawns, so the swallow is deterministic, not a
// race we have to widen a window to catch. The fake blocks until we've
// released it so the in-flight export is genuinely still running when the
// second click lands. Coordination is via channels, not wall-clock polls.
func TestStartExport_CASGuardSwallowsSecondClick(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	var calls atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	withExportFn(t, func(diagnostics.ExportOptions) (string, error) {
		// Only the first entrant touches the barrier channels — guarding on
		// the call count means a regression that lets a second goroutine in
		// (CAS removed) records calls==2 and fails the assertion below
		// cleanly, instead of panicking on a double channel close.
		if calls.Add(1) != 1 {
			return "", errors.New("test-cancelled")
		}
		// runExport's deferred exporting.Store(false) fires after this
		// returns; closing finished here (deferred) plus draining release
		// lets the test observe completion without polling the atomic.
		defer close(finished)
		close(entered)
		<-release
		return "", errors.New("test-cancelled")
	})
	withRevealOverride(t)

	var sd atomic.Bool
	tc := &trayController{shuttingDown: &sd}

	tc.startExport()
	<-entered        // first export goroutine is now inside exportFn
	tc.startExport() // second click while first is in flight — CAS no-op
	close(release)   // let the in-flight export return
	<-finished       // fake has returned; runExport is unwinding

	// runExport clears exporting in a defer that runs after the fake
	// returns. Synchronize on that defer by spinning the scheduler until
	// the goroutine has unwound — bounded by the test's own deadline, not
	// a wall clock: a hung goroutine would leak and fail the suite anyway.
	for tc.exporting.Load() {
		runtime.Gosched()
	}

	if got := calls.Load(); got != 1 {
		t.Errorf("export invocations = %d, want 1 (CAS guard failed)", got)
	}
	if tc.exporting.Load() {
		t.Error("exporting flag still set after the in-flight export completed")
	}
}

// TestStartExport_RefusedDuringShutdown verifies the shutdown gate.
// Once shuttingDown is set, Export clicks become no-ops — performShutdown
// is tearing the daemon down and any bundle-all call would race against
// the daemon's HTTP server closing.
func TestStartExport_RefusedDuringShutdown(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	var calls atomic.Int32
	withExportFn(t, func(diagnostics.ExportOptions) (string, error) {
		calls.Add(1)
		return "", nil
	})
	withRevealOverride(t)

	var sd atomic.Bool
	sd.Store(true)
	tc := &trayController{shuttingDown: &sd}

	tc.startExport()

	if got := calls.Load(); got != 0 {
		t.Errorf("export invocations during shutdown = %d, want 0", got)
	}
	if tc.exporting.Load() {
		t.Error("exporting flag set after shutdown-refused click")
	}
}

// TestRunExport_SuccessRevealsAndSetsTransient walks the happy path:
// export returns a zip path, reveal is invoked, success transient is
// armed, exporting flag clears, no failure msg is set.
func TestRunExport_SuccessRevealsAndSetsTransient(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	zipPath := filepath.Join(t.TempDir(), "friday-diagnostics-test.zip")
	if err := os.WriteFile(zipPath, []byte("ignored"), 0o600); err != nil {
		t.Fatal(err)
	}
	var seenOpts diagnostics.ExportOptions
	withExportFn(t, func(o diagnostics.ExportOptions) (string, error) {
		seenOpts = o
		return zipPath, nil
	})
	revealCalls := withRevealOverride(t)

	var sd atomic.Bool
	tc := &trayController{shuttingDown: &sd}
	tc.exporting.Store(true) // runExport assumes startExport already CAS'd

	tc.runExport()

	if tc.exporting.Load() {
		t.Error("exporting flag still set after runExport returned")
	}
	if *revealCalls != 1 {
		t.Errorf("reveal calls = %d, want 1", *revealCalls)
	}
	if seenOpts.DaemonURL == "" {
		t.Error("Export called with empty DaemonURL — daemonAPIBaseURL() not threaded through")
	}
	tc.exportMu.Lock()
	defer tc.exportMu.Unlock()
	if tc.exportFailureMsg != "" {
		t.Errorf("exportFailureMsg = %q, want empty on success", tc.exportFailureMsg)
	}
	if tc.exportSuccessUntilTS.IsZero() {
		t.Error("exportSuccessUntilTS not armed after success")
	}
	if tc.exportProgressPhase != "" {
		t.Errorf("exportProgressPhase = %q, want empty after run completes", tc.exportProgressPhase)
	}
}

// TestRunExport_FailureSetsStickyLabel: when diagnostics.Export
// returns an error, the menu label flips to the failure message and
// stays there (sticky until next click). The CAS guard clears so the
// user can retry.
func TestRunExport_FailureSetsStickyLabel(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	withExportFn(t, func(diagnostics.ExportOptions) (string, error) {
		return "", errors.New("disk full")
	})
	revealCalls := withRevealOverride(t)

	var sd atomic.Bool
	tc := &trayController{shuttingDown: &sd}
	tc.exporting.Store(true)

	tc.runExport()

	if tc.exporting.Load() {
		t.Error("exporting flag still set after failed runExport")
	}
	if *revealCalls != 0 {
		t.Errorf("reveal calls on failure = %d, want 0", *revealCalls)
	}
	tc.exportMu.Lock()
	defer tc.exportMu.Unlock()
	if tc.exportFailureMsg != exportItemFailure {
		t.Errorf("exportFailureMsg = %q, want %q", tc.exportFailureMsg, exportItemFailure)
	}
	if !tc.exportSuccessUntilTS.IsZero() {
		t.Error("exportSuccessUntilTS armed despite failure")
	}
}

// TestRunExport_PassesIncludeWorkspacesFromState: the daemon-bound
// IncludeWorkspaces flag must come from persisted state, not from any
// hidden in-memory cache. Otherwise the menu checkbox and the export
// request can drift if the user toggles + restarts.
func TestRunExport_PassesIncludeWorkspacesFromState(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	if err := writeState(launcherState{IncludeWorkspaces: true}); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	var seenOpts diagnostics.ExportOptions
	withExportFn(t, func(o diagnostics.ExportOptions) (string, error) {
		seenOpts = o
		return "", errors.New("stop here") // skip reveal
	})
	withRevealOverride(t)

	var sd atomic.Bool
	tc := &trayController{shuttingDown: &sd}
	tc.exporting.Store(true)

	tc.runExport()

	if !seenOpts.IncludeWorkspaces {
		t.Error("Export called with IncludeWorkspaces=false, want true (persisted state)")
	}
}

// TestSetExportPhase_WritesUnderMutex confirms ProgressFn callbacks
// land in the field tick() reads. Without this the menu label would
// never reflect the diagnostics package's progress events.
func TestSetExportPhase_WritesUnderMutex(t *testing.T) {
	tc := &trayController{}
	tc.setExportPhase("workspaces")
	tc.exportMu.Lock()
	defer tc.exportMu.Unlock()
	if tc.exportProgressPhase != "workspaces" {
		t.Errorf("exportProgressPhase = %q, want %q", tc.exportProgressPhase, "workspaces")
	}
}

// TestSetExportPhase_NoDeadlockOnImmediateRefresh guards the lock
// contract behind the immediate label refresh: setExportPhase writes
// the phase under exportMu, then calls updateExportItemLabel which
// re-acquires exportMu. If a refactor ever leaves the write lock held
// across that call, the non-reentrant mutex deadlocks. The nil
// exportItem hits updateExportItemLabel's nil-guard, so this needs no
// live systray. A watchdog fails the test instead of hanging the suite.
func TestSetExportPhase_NoDeadlockOnImmediateRefresh(t *testing.T) {
	tc := &trayController{} // exportItem nil → updateExportItemLabel returns early

	done := make(chan struct{})
	go func() {
		tc.setExportPhase("logs")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("setExportPhase deadlocked — exportMu held across updateExportItemLabel")
	}
}

// TestToggleIncludeWorkspaces_Persists confirms a click flips the
// persisted state on disk (read-modify-write through writeState).
// Without this the preference resets every launcher boot.
func TestToggleIncludeWorkspaces_Persists(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	tc := &trayController{}

	tc.toggleIncludeWorkspaces()
	if got := readState().IncludeWorkspaces; !got {
		t.Errorf("after first toggle IncludeWorkspaces = false, want true")
	}

	tc.toggleIncludeWorkspaces()
	if got := readState().IncludeWorkspaces; got {
		t.Errorf("after second toggle IncludeWorkspaces = true, want false")
	}
}

// TestToggleIncludeWorkspaces_PreservesAutostartInitialized is the
// regression test for the read-modify-write fix in
// runAutostartCommand. If toggleIncludeWorkspaces clobbered other
// state fields, an autostart-enabled launcher would re-run the
// self-register on every boot.
func TestToggleIncludeWorkspaces_PreservesAutostartInitialized(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	if err := writeState(launcherState{AutostartInitialized: true}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	tc := &trayController{}
	tc.toggleIncludeWorkspaces()

	got := readState()
	if !got.AutostartInitialized {
		t.Error("AutostartInitialized cleared by toggleIncludeWorkspaces — read-modify-write broken")
	}
	if !got.IncludeWorkspaces {
		t.Error("IncludeWorkspaces not flipped to true")
	}
}

// TestDeriveExportItemLabel walks every branch of the label derivation
// — pure function, no systray. Covers the full progress phase ladder
// (logs → workspaces → packaging), the failure sticky path, and the
// success transient's active + expired states. The expired branch is
// the one updateExportItemLabel acts on to re-enable the menu item.
func TestDeriveExportItemLabel(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name        string
		state       exportLabelState
		wantLabel   string
		wantExpired bool
	}{
		{
			name:      "default",
			state:     exportLabelState{now: now},
			wantLabel: exportItemDefault,
		},
		{
			name:      "progress logs",
			state:     exportLabelState{progressPhase: "logs", now: now},
			wantLabel: exportItemProgressBase + " (logs)",
		},
		{
			name:      "progress workspaces",
			state:     exportLabelState{progressPhase: "workspaces", now: now},
			wantLabel: exportItemProgressBase + " (workspaces)",
		},
		{
			name:      "progress packaging",
			state:     exportLabelState{progressPhase: "packaging", now: now},
			wantLabel: exportItemProgressBase + " (packaging)",
		},
		{
			name:      "failure sticky",
			state:     exportLabelState{failureMsg: exportItemFailure, now: now},
			wantLabel: exportItemFailure,
		},
		{
			name: "success transient active",
			state: exportLabelState{
				successUntilTS: now.Add(1 * time.Second),
				now:            now,
			},
			wantLabel: exportItemSuccess,
		},
		{
			name: "success transient expired",
			state: exportLabelState{
				successUntilTS: now.Add(-1 * time.Second),
				now:            now,
			},
			wantLabel:   exportItemDefault,
			wantExpired: true,
		},
		{
			name: "progress beats success transient",
			state: exportLabelState{
				progressPhase:  "logs",
				successUntilTS: now.Add(1 * time.Second),
				now:            now,
			},
			wantLabel: exportItemProgressBase + " (logs)",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			label, expired := deriveExportItemLabel(c.state)
			if label != c.wantLabel {
				t.Errorf("label = %q, want %q", label, c.wantLabel)
			}
			if expired != c.wantExpired {
				t.Errorf("expired = %v, want %v", expired, c.wantExpired)
			}
		})
	}
}
