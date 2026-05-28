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
	checked   bool
	enabled   bool
}

func (r *recordingMenuItem) SetTitle(s string) { r.calls++; r.lastTitle = s }
func (r *recordingMenuItem) Enable()           { r.calls++; r.enabled = true }
func (r *recordingMenuItem) Disable()          { r.calls++; r.enabled = false }
func (r *recordingMenuItem) Check()            { r.calls++; r.checked = true }
func (r *recordingMenuItem) Uncheck()          { r.calls++; r.checked = false }

// TestMenuMutations_NoRaceUnderConcurrency hammers the two shared menu
// items from all three goroutines that touch them in production —
// tick() (updateExportItemLabel + updateIncludeWorkspacesAvailability),
// the export goroutine (setExportPhase, the runExport Enable paths),
// and the click handler (toggleIncludeWorkspaces) — with recording
// fakes injected behind the menuItem interface. Run under `-race` this
// is the load-bearing proof that menuMu serializes every mutation; with
// menuMu removed the unguarded fakes trip the race detector.
func TestMenuMutations_NoRaceUnderConcurrency(t *testing.T) {
	t.Setenv("FRIDAY_LAUNCHER_HOME", t.TempDir())

	var sd atomic.Bool
	cache := NewHealthCache(&sd)
	sup := newTestSupervisor(time.Now(), false)

	tc := newTrayController(sup, &sd, cache)
	exportFake := &recordingMenuItem{}
	includeFake := &recordingMenuItem{}
	tc.exportItem = exportFake
	tc.includeWorkspacesItem = includeFake

	const workers = 8
	const iters = 200
	var wg sync.WaitGroup

	// tick path: a SINGLE goroutine, mirroring production's lone
	// pollLoop. updateIncludeWorkspacesAvailability reads/writes the
	// unsynchronized daemonEnabledForInclude field, which is correct
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
			tc.updateIncludeWorkspacesAvailability()
		}
	}()

	// export-goroutine path: phase updates (immediate label refresh) and
	// the failure/success Enable paths via setExportPhase.
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

	// click path: toggleIncludeWorkspaces always Check/Unchecks the
	// include item after the state read.
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for n := 0; n < iters; n++ {
				tc.toggleIncludeWorkspaces()
			}
		}()
	}

	wg.Wait()

	// Sanity: every path ran and mutated through the fakes. The real
	// assertion is the race detector; these guard against the test
	// silently no-opping (e.g. a nil-guard short-circuiting everything).
	tc.menuMu.Lock()
	defer tc.menuMu.Unlock()
	if exportFake.calls == 0 {
		t.Error("exportItem never mutated — test exercised nothing")
	}
	if includeFake.calls == 0 {
		t.Error("includeWorkspacesItem never mutated — test exercised nothing")
	}
}
