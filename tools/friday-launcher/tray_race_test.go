package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recordingMenuItem is a test double for the menuItem interface. Its
// internal state is DELIBERATELY UNGUARDED — no mutex of its own. The
// production race this test guards against is exactly that: the real
// *systray.MenuItem mutators write internal fields with no locking, so
// the only thing standing between concurrent tick / click / export
// goroutines and a data race is trayController.menuMu. If menuMu is
// ever dropped, `go test -race` must fire on these unsynchronized
// writes. Adding a lock here would mask that — so don't.
type recordingMenuItem struct {
	calls     int
	lastTitle string
	enabled   bool
}

func (r *recordingMenuItem) SetTitle(s string) { r.calls++; r.lastTitle = s }
func (r *recordingMenuItem) Enable()           { r.calls++; r.enabled = true }
func (r *recordingMenuItem) Disable()          { r.calls++; r.enabled = false }

// TestMenuMutations_NoRaceUnderConcurrency hammers the two shared menu
// items from the goroutines that touch them in production — tick()
// (updateExportItemLabel + updateWorkspacesItemAvailability) and the
// export goroutine (setExportPhase's immediate label refresh) — with
// recording fakes injected behind the menuItem interface. The parent
// (exportItem) is mutated concurrently by tick plus every setExportPhase
// worker, so it's the load-bearing case. Run under `-race` this proves
// menuMu serializes every mutation; with menuMu removed the unguarded
// fakes trip the race detector.
func TestMenuMutations_NoRaceUnderConcurrency(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	sup := newTestSupervisor(time.Now(), false)

	tc := newTrayController(sup, &sd, cache)
	exportFake := &recordingMenuItem{}
	workspacesFake := &recordingMenuItem{}
	tc.exportItem = exportFake
	tc.logsWorkspacesItem = workspacesFake

	const workers = 8
	const iters = 200
	var wg sync.WaitGroup

	// tick path: a SINGLE goroutine, mirroring production's lone
	// pollLoop. updateWorkspacesItemAvailability reads/writes the
	// unsynchronized daemonEnabledForWorkspaces field, which is correct
	// precisely because only tick touches it — driving it from many
	// goroutines would manufacture a race that production can't hit. We
	// flip the daemon verdict each iteration so the availability path
	// actually mutates the item (it coalesces on the verdict otherwise).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for n := 0; n < iters*workers; n++ {
			cache.SetReady(daemonServiceName, n%2 == 0)
			cache.Update(makeStates(runningReady(daemonServiceName)))
			tc.updateExportItemLabel()
			tc.updateWorkspacesItemAvailability()
		}
	}()

	// export-goroutine path: phase updates drive updateExportItemLabel,
	// mutating the parent concurrently with the tick goroutine above.
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			phases := []string{"logs", "workspaces", "packaging", ""}
			for n := 0; n < iters; n++ {
				tc.setExportPhase(phases[n%len(phases)])
			}
		}()
	}

	wg.Wait()

	// Sanity: both items were mutated through the fakes. The real
	// assertion is the race detector; these guard against the test
	// silently no-opping (e.g. a nil-guard short-circuiting everything).
	tc.menuMu.Lock()
	defer tc.menuMu.Unlock()
	if exportFake.calls == 0 {
		t.Error("exportItem never mutated — test exercised nothing")
	}
	if workspacesFake.calls == 0 {
		t.Error("logsWorkspacesItem never mutated — test exercised nothing")
	}
}
