package main

import (
	_ "embed"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/systray"

	"github.com/friday-platform/friday-studio/tools/friday-launcher/diagnostics"
)

// iconFridayTemplate is a pure-black silhouette of the Friday "P" mark.
// macOS treats it as a template image and auto-tints to match the
// menubar (white on dark, black on light) — this is the canonical
// menubar-icon shape and the only way to get crisp visibility against
// dark menubars without shipping multiple per-mode bitmaps.
//
// iconFriday is the colored fallback for non-macOS platforms (Windows
// renders the bytes as-is; no template-tinting).
//
//go:embed assets/tray-friday-template.png
var iconFridayTemplate []byte

//go:embed assets/tray-friday.png
var iconFriday []byte

// trayBucket represents the rendered status — used for the menubar
// title text + tooltip. The tray *icon* itself is always the Friday
// logo regardless of state; status is conveyed via title text next
// to the icon (always visible, doesn't fight NSMenu's chevron).
type trayBucket int

const (
	bucketAmber trayBucket = iota // default while starting up
	bucketGreen
	bucketRed
	bucketGrey // shutting down
)

// titleText returns the text shown next to the menubar icon. We
// surface status here (instead of as the first menu item) because
// macOS NSMenu's popUpMenuPositioningItem can clip the first menu
// row behind a scroll-up chevron, hiding the status text. Title text
// is in the menubar itself and is always visible — no menu open
// required, no NSMenu layout quirks.
//
// Green is empty so the menubar stays clean while everything is
// healthy; non-green states announce themselves so the user notices
// at a glance.
func (b trayBucket) titleText() string {
	switch b {
	case bucketGreen:
		return ""
	case bucketRed:
		return " Error"
	case bucketGrey:
		return " Stopping…"
	default:
		return " Starting…"
	}
}

func (b trayBucket) tooltip() string {
	switch b {
	case bucketGreen:
		return "Friday Studio — running"
	case bucketRed:
		return "Friday Studio — error"
	case bucketGrey:
		return "Friday Studio — shutting down…"
	default:
		return "Friday Studio — starting…"
	}
}

// Title/tooltip overrides applied on top of computeBucket while a
// diagnostic export is in flight. Same shape as bucketGrey's
// " Stopping…" / "Friday Studio — shutting down…" pair — single
// place to read so a copy edit doesn't drift across the codebase.
const (
	exportingTitle   = " Exporting…"
	exportingTooltip = "Friday Studio — exporting diagnostics…"
)

// Menu item labels. The export action is a parent menu item with a
// submenu of two explicit actions ("Logs only", "Logs + workspaces");
// the parent's title carries the progress/success/failure feedback,
// written from the export goroutine. The default is the resting state.
const (
	exportItemDefault      = "Export diagnostics"
	exportItemProgressBase = "Exporting diagnostics…"
	exportItemSuccess      = "Exported ✓ — revealing…"
	exportItemFailure      = "Export failed — see launcher.log"
	logsOnlyLabel          = "Logs only"
	logsWorkspacesLabel    = "Logs + workspaces"
	logsWorkspacesDisable  = " — start Friday Studio to enable"
)

// daemonServiceName is the supervised process whose liveness gates
// the "Logs + workspaces" action. Defined here (not in healthsvc.go)
// because the tray is the only consumer that cares which service is
// the daemon — healthsvc treats every service uniformly.
const daemonServiceName = "friday"

// menuItem is the subset of *systray.MenuItem mutators that the two
// shared items (exportItem parent, logsWorkspacesItem) are driven
// through. Carved out as an interface purely so tests can inject a
// recording fake — *systray.MenuItem can't be constructed without a
// live tray. ClickedCh is deliberately NOT here: it's a struct field
// on the concrete item, read only from the single-goroutine
// handleClicks, so onReady captures it into a dedicated channel field.
type menuItem interface {
	SetTitle(string)
	Enable()
	Disable()
}

// exportSuccessHold is how long the menu item shows the success label
// before reverting to the default. Sized so a quick reader sees the
// ✓ but the menu doesn't feel sticky if they re-open it later.
const exportSuccessHold = 1500 * time.Millisecond

// trayController owns the systray menu items and the polling loop.
type trayController struct {
	sup          *Supervisor
	shuttingDown *atomic.Bool
	healthCache  *HealthCache

	openedBrowserOnce atomic.Bool

	// menu items kept around so we can update labels / disable / enable
	openItem      *systray.MenuItem
	restartItem   *systray.MenuItem
	logsItem      *systray.MenuItem
	autostartItem *systray.MenuItem
	quitItem      *systray.MenuItem

	// exportItem is the "Export diagnostics" parent. Its title carries
	// the progress/success/failure feedback (mutated from tick and the
	// export goroutine) and it's disabled for the duration of an export
	// so its submenu is inaccessible while one is in flight.
	// logsWorkspacesItem is the daemon-gated sub-action (mutated from
	// tick only). Both sit behind the menuItem interface so tests can
	// inject a fake. The logs-only sub-item is never mutated after
	// creation — parent-disable covers it — so only its click channel
	// is kept. Click channels live in the *ClickedCh fields below since
	// the interface intentionally omits ClickedCh.
	exportItem         menuItem
	logsWorkspacesItem menuItem

	// Click channels captured from the concrete items in onReady.
	// handleClicks (the sole reader) selects on these instead of
	// reaching through the now-interface-typed item fields.
	logsOnlyClickedCh       <-chan struct{}
	logsWorkspacesClickedCh <-chan struct{}

	currentBucket trayBucket

	// lastTitle is the menubar title we most recently asked systray to
	// render. Used to coalesce SetTitle calls when neither bucket nor
	// the exporting override has changed since the prior tick — macOS
	// NSStatusItem redraws on every SetTitle call.
	lastTitle string

	// exporting is the CAS guard for the diagnostic-export action.
	// The handler does CompareAndSwap(false, true) BEFORE spawning the
	// goroutine — a second click while a prior export is in flight
	// finds the slot taken and is a no-op. Disabling the menu item is
	// best-effort UX; the CAS is the actual correctness barrier.
	exporting atomic.Bool

	// exportMu guards the progress + failure + success-until fields
	// below. They're written from the export goroutine and read from
	// the tray tick(), so a small mutex is the obvious shape.
	exportMu             sync.Mutex
	exportProgressPhase  string    // "" when no export is in flight
	exportFailureMsg     string    // sticky until next export click
	exportSuccessUntilTS time.Time // zero value when no success transient

	// menuMu serializes every mutation of the two shared menu items
	// (exportItem parent, logsWorkspacesItem) across the tick and export
	// goroutines. systray.MenuItem's SetTitle/Enable/Disable write the
	// item's internal fields without any locking of their own, so
	// without this the tick / export goroutines race on them. Lock
	// ordering: NEVER held with exportMu. Callers derive state under
	// exportMu, release it, THEN take menuMu for the systray call.
	menuMu sync.Mutex

	// daemonEnabledForWorkspaces mirrors the last enable/disable verdict
	// for the "Logs + workspaces" item so we only call Enable/Disable on
	// the cross-platform systray when the verdict actually flips. Avoids
	// per-tick churn on macOS NSMenu which redraws on Enable.
	daemonEnabledForWorkspaces bool
}

func newTrayController(
	sup *Supervisor,
	shuttingDown *atomic.Bool,
	healthCache *HealthCache,
) *trayController {
	return &trayController{
		sup:          sup,
		shuttingDown: shuttingDown,
		healthCache:  healthCache,
	}
}

func (t *trayController) onReady() {
	// Template icon on macOS auto-tints to menubar color; on Windows
	// the second arg is used as a regular icon.
	systray.SetTemplateIcon(iconFridayTemplate, iconFriday)
	// Initial title shows "Starting…" next to the icon. tick() keeps
	// it in sync with bucket changes; green clears it back to "" so
	// the menubar stays clean while everything is healthy.
	systray.SetTitle(bucketAmber.titleText())
	systray.SetTooltip(bucketAmber.tooltip())
	t.lastTitle = bucketAmber.titleText()

	t.openItem = systray.AddMenuItem("Open in browser", "Open Friday Studio")
	t.restartItem = systray.AddMenuItem("Restart all", "Stop and start every supervised process")
	t.logsItem = systray.AddMenuItem("View logs", "Open ~/.friday/local/logs in your file browser")
	// "Export diagnostics" is a parent item; its two sub-actions are the
	// explicit export variants. The parent title carries progress
	// feedback and is disabled while an export runs. Capture each
	// concrete sub-item locally so we can grab ClickedCh (a struct
	// field, absent from the menuItem interface) before narrowing the
	// parent to the interface type.
	exportItem := systray.AddMenuItem(
		exportItemDefault,
		"Build a one-click diagnostic zip and reveal it in your file browser")
	t.exportItem = exportItem
	logsOnlyItem := exportItem.AddSubMenuItem(
		logsOnlyLabel,
		"Export logs, launcher state, and pids only")
	t.logsOnlyClickedCh = logsOnlyItem.ClickedCh
	logsWorkspacesItem := exportItem.AddSubMenuItem(
		logsWorkspacesLabel,
		"Also embed each workspace's definition zip (needs the daemon running)")
	t.logsWorkspacesItem = logsWorkspacesItem
	t.logsWorkspacesClickedCh = logsWorkspacesItem.ClickedCh
	systray.AddSeparator()
	t.autostartItem = systray.AddMenuItemCheckbox(
		"Start at login",
		"Re-launch Friday Studio when you next log in",
		isAutostartEnabled())
	systray.AddSeparator()
	t.quitItem = systray.AddMenuItem("Quit", "Shut down Friday Studio cleanly")
	// Optimistically enabled — tick() will Disable on the next 2s
	// pass if the daemon isn't healthy yet. Mirror the same default
	// so the first tick is a no-op when the daemon comes up fast.
	t.daemonEnabledForWorkspaces = true

	go t.handleClicks()
	go t.pollLoop()
}

func (t *trayController) handleClicks() {
	for {
		select {
		case <-t.openItem.ClickedCh:
			t.openBrowser("user click")
		case <-t.restartItem.ClickedCh:
			if t.sup.SupervisorExited() {
				log.Warn("restart-all requested but supervisor exited; ignoring")
				continue
			}
			log.Info("Restart all triggered from tray")
			go func() {
				if err := t.sup.RestartAll(); err != nil {
					log.Error("restart-all failed", "error", err)
				}
			}()
		case <-t.logsItem.ClickedCh:
			if err := openInFileBrowser(logsDir()); err != nil {
				log.Error("open logs dir failed", "error", err)
			}
		case <-t.logsOnlyClickedCh:
			t.startExport(false)
		case <-t.logsWorkspacesClickedCh:
			t.startExport(true)
		case <-t.autostartItem.ClickedCh:
			if t.autostartItem.Checked() {
				if err := disableAutostart(); err != nil {
					log.Error("disableAutostart failed", "error", err)
				} else {
					t.autostartItem.Uncheck()
				}
			} else {
				if err := enableAutostart(); err != nil {
					log.Error("enableAutostart failed", "error", err)
				} else {
					t.autostartItem.Check()
				}
			}
		case <-t.quitItem.ClickedCh:
			log.Info("Quit requested from tray")
			// Decision #2: confirmation modal before tearing down
			// services. Cancel returns to the menu without
			// affecting state. confirmQuit blocks the click
			// handler for the duration of the dialog (acceptable
			// — the user is interacting with us synchronously).
			if !confirmQuit() {
				log.Info("Quit cancelled by user")
				continue
			}
			// Flip the menubar title to "Stopping…" before
			// systray.Quit so the user sees feedback during the
			// up-to-30s teardown. shuttingDown is set inside
			// performShutdown (which onExit calls), but the title
			// update here gives instant visual confirmation —
			// otherwise the menubar shows the previous bucket
			// label until the next pollLoop tick.
			t.shuttingDown.Store(true)
			systray.SetTitle(bucketGrey.titleText())
			systray.SetTooltip(bucketGrey.tooltip())
			t.lastTitle = bucketGrey.titleText()
			systray.Quit()
			return
		}
	}
}

// pollLoop reads supervisor state every 2s and updates the tooltip +
// status text. The tray icon itself is always the Friday logo; status
// is conveyed via menu text + tooltip so the icon stays brand-stable.
func (t *trayController) pollLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	t.tick()
	for range ticker.C {
		t.tick()
	}
}

func (t *trayController) tick() {
	bucket := t.computeBucket()
	exporting := t.exporting.Load()
	wantTitle := bucket.titleText()
	wantTooltip := bucket.tooltip()
	if exporting {
		// Export-in-flight wins over the bucket-derived title — the
		// user just clicked Export and needs immediate visual feedback
		// that something is happening. Shutdown still wins (shuttingDown
		// trumps every other signal in computeBucket, and the click
		// handler refuses Export after shutdown begins).
		wantTitle = exportingTitle
		wantTooltip = exportingTooltip
	}
	// Coalesce on the rendered title string so NSStatusItem only
	// redraws when something actually changed. Covers both bucket
	// transitions and the export-in-flight override flipping on/off.
	if wantTitle != t.lastTitle {
		systray.SetTooltip(wantTooltip)
		systray.SetTitle(wantTitle)
		t.lastTitle = wantTitle
	}
	t.currentBucket = bucket
	t.updateExportItemLabel()
	t.updateWorkspacesItemAvailability()
	if bucket == bucketGreen {
		// Open browser exactly once on first transition to green
		// (and only if --no-browser wasn't set, which is checked
		// inside openBrowser via the noBrowser global).
		if t.openedBrowserOnce.CompareAndSwap(false, true) {
			t.openBrowser("first healthy")
		}
	}
}

// bucketFailGraceWindow is how long the tray forgives transient
// AnyFailed before flipping red. Two callers consult it:
//   - computeBucket compares it against time.Since(StartedAt()) for
//     the cold-start grace.
//   - Supervisor.RestartGraceActive() (supervisor.go) uses the same
//     value as the post-restart grace window so a user-initiated
//     Restart gets equivalent forgiveness.
//
// Sized to cover the readiness probe budget configured in
// project.go: InitialDelay=2s + FailureThreshold=30 × PeriodSeconds=2s
// = 62s worst case before process-compose itself declares a service
// unhealthy. The previous 30s magnitude was inherited from before
// the readiness budget was widened to 62s and would paint red for
// any service that legitimately took >30s to first-pass readiness
// (which the friday daemon does on cold start).
const bucketFailGraceWindow = 90 * time.Second

// computeBucket implements the Tray Color Matrix using the health
// cache as the single source of truth (Decision #4 + #18). The
// previous heuristic (state.IsReady() over ProcessesState) suffered
// from the v0.1.15 "stuck on Starting…" bug because it required
// every process's readiness probe to fire green AND every state's
// IsReady to be non-nil; one mis-configured probe wedged the bucket
// forever. The cache decouples our state machine from process-
// compose's so we can give honest UX even when an upstream probe
// is broken.
//
// Order matters:
//  1. shuttingDown trumps everything (grey).
//  2. SupervisorExited (the runner.Run() returned unexpectedly)
//     trumps everything else (red).
//  3. AllHealthy → green.
//  4. AnyFailed past the cold-start grace AND no active restart
//     grace → red.
//  5. Otherwise amber (pending / starting / cold-start grace /
//     restart grace).
func (t *trayController) computeBucket() trayBucket {
	if t.shuttingDown.Load() {
		return bucketGrey
	}
	if t.sup.SupervisorExited() {
		return bucketRed
	}
	if t.healthCache == nil {
		// Defensive: if we somehow got here before the cache was
		// wired, render amber to avoid mis-rendering as red.
		return bucketAmber
	}
	if t.healthCache.AllHealthy() {
		return bucketGreen
	}
	// AnyFailed flips to red only outside both the cold-start grace
	// and the post-restart grace. Without the restart-grace check a
	// user-initiated tray Restart would paint " Error" for the few
	// seconds children take to stop + come back up — process-compose
	// reports them as not-running during that window, which the
	// cache surfaces as failed.
	if t.healthCache.AnyFailed() &&
		time.Since(t.sup.StartedAt()) >= bucketFailGraceWindow &&
		!t.sup.RestartGraceActive() {
		return bucketRed
	}
	return bucketAmber
}

func (t *trayController) openBrowser(reason string) {
	// --no-browser only suppresses the auto-open on first-healthy
	// transition. User-initiated actions (tray click, second-instance
	// wake-up) always open — otherwise the menu item silently does
	// nothing, which is worse than honoring the flag would buy us.
	//
	// Test isolation uses a separate env-var override
	// (FRIDAY_LAUNCHER_BROWSER_DISABLED) so `go test` can spawn the
	// launcher subprocess without popping tabs on the developer's
	// machine. The env var is internal — never documented in user-
	// facing CLI help — and is the only way to absolutely suppress
	// every openBrowser call.
	if browserDisabled {
		log.Info("browser-open suppressed by env var", "reason", reason)
		return
	}
	if noBrowser && reason == "first healthy" {
		log.Info("browser-open suppressed by --no-browser", "reason", reason)
		return
	}
	url := playgroundURL()
	log.Info("opening browser", "reason", reason, "url", url)
	if err := openURLInBrowser(url); err != nil {
		log.Error("openBrowser failed", "error", err)
	}
}

func (t *trayController) wakeFromSecondInstance() {
	// Wake-up bypasses the once-per-session guard so a second-instance
	// click always opens the browser.
	t.openBrowser("second-instance wake")
}

// updateWorkspacesItemAvailability disables the "Logs + workspaces"
// sub-action when the daemon isn't healthy (the /bundle-all endpoint
// needs a live daemon) and re-enables it once the daemon comes up. The
// "Logs only" action is always available and needs no gating. Only the
// label suffix + interactability change.
//
// Coalesced on daemonEnabledForWorkspaces so we don't call SetTitle on
// every 2s tick when the state hasn't changed (macOS NSMenu redraws
// on each SetTitle).
func (t *trayController) updateWorkspacesItemAvailability() {
	if t.logsWorkspacesItem == nil {
		return
	}
	daemonUp := t.healthCache != nil && t.healthCache.ServiceHealthy(daemonServiceName)
	if daemonUp == t.daemonEnabledForWorkspaces {
		return
	}
	t.menuMu.Lock()
	if daemonUp {
		t.logsWorkspacesItem.SetTitle(logsWorkspacesLabel)
		t.logsWorkspacesItem.Enable()
	} else {
		t.logsWorkspacesItem.SetTitle(logsWorkspacesLabel + logsWorkspacesDisable)
		t.logsWorkspacesItem.Disable()
	}
	t.menuMu.Unlock()
	t.daemonEnabledForWorkspaces = daemonUp
}

// exportLabelState is a snapshot of the export-related fields the
// label derivation reads. Pulled out so the pure renderer can be
// unit-tested without a real systray (the menu mutation in
// updateExportItemLabel is the side effect; the string derivation is
// the logic).
type exportLabelState struct {
	progressPhase  string
	failureMsg     string
	successUntilTS time.Time
	now            time.Time
}

// deriveExportItemLabel maps the current export state to the rendered
// menu label. Pure function — no systray side effects, no mutex.
func deriveExportItemLabel(s exportLabelState) (label string, successExpired bool) {
	switch {
	case s.progressPhase != "":
		suffix := ""
		switch s.progressPhase {
		case "logs":
			suffix = " (logs)"
		case "workspaces":
			suffix = " (workspaces)"
		case "packaging":
			suffix = " (packaging)"
		}
		return exportItemProgressBase + suffix, false
	case !s.successUntilTS.IsZero():
		if s.now.Before(s.successUntilTS) {
			return exportItemSuccess, false
		}
		return exportItemDefault, true
	case s.failureMsg != "":
		return s.failureMsg, false
	default:
		return exportItemDefault, false
	}
}

// updateExportItemLabel rewrites the export menu item's label based on
// the current progress/failure/success state. Called from tick() so
// label updates land on the existing 2s polling cadence — no separate
// timer goroutine needed. The success transient expires on its own
// when time.Now() crosses exportSuccessUntilTS.
func (t *trayController) updateExportItemLabel() {
	if t.exportItem == nil {
		return
	}
	t.exportMu.Lock()
	state := exportLabelState{
		progressPhase:  t.exportProgressPhase,
		failureMsg:     t.exportFailureMsg,
		successUntilTS: t.exportSuccessUntilTS,
		now:            time.Now(),
	}
	label, expired := deriveExportItemLabel(state)
	if expired {
		t.exportSuccessUntilTS = time.Time{}
	}
	// Lock ordering: release exportMu BEFORE taking menuMu — the two are
	// never held together (see menuMu doc). exportMu guards the string
	// fields; menuMu guards the systray mutation that follows.
	t.exportMu.Unlock()
	t.menuMu.Lock()
	t.exportItem.SetTitle(label)
	if expired {
		t.exportItem.Enable()
	}
	t.menuMu.Unlock()
}

// startExport handles a click on either export sub-action.
// includeWorkspaces is true for "Logs + workspaces", false for
// "Logs only". The CAS on `exporting` is the real concurrency guard —
// a second click during an in-flight export finds the slot taken and
// is a no-op. Disabling the parent item is best-effort visual feedback
// (it also makes the submenu inaccessible for the duration).
func (t *trayController) startExport(includeWorkspaces bool) {
	if t.shuttingDown.Load() {
		// Refuse new exports during shutdown — performShutdown is
		// tearing the daemon down and any /bundle-all call would race
		// against the daemon's HTTP server closing.
		return
	}
	if !t.exporting.CompareAndSwap(false, true) {
		return
	}
	if t.exportItem != nil {
		t.menuMu.Lock()
		t.exportItem.Disable()
		t.menuMu.Unlock()
	}
	t.exportMu.Lock()
	t.exportFailureMsg = ""
	t.exportSuccessUntilTS = time.Time{}
	t.exportProgressPhase = "logs" // optimistic — Export will overwrite
	t.exportMu.Unlock()
	go t.runExport(includeWorkspaces)
}

// exportFn is the diagnostics.Export call, swappable for tests so the
// tray click flow can be exercised end-to-end without hitting disk or
// the live daemon. Production code leaves it nil; the helper at the
// bottom of this method picks the real function in that case.
var exportFn func(diagnostics.ExportOptions) (string, error)

// runExport is the export goroutine. Owns the exporting atomic.Bool
// across its full lifetime (set by startExport before spawn, cleared
// here on return). includeWorkspaces comes straight from the clicked
// sub-action — there is no persisted preference. Posts progress to the
// tray via setExportPhase; reveals on success; leaves a sticky failure
// label on error.
func (t *trayController) runExport(includeWorkspaces bool) {
	defer t.exporting.Store(false)

	opts := diagnostics.ExportOptions{
		IncludeWorkspaces: includeWorkspaces,
		DaemonURL:         daemonAPIBaseURL(),
		ProgressFn:        t.setExportPhase,
	}
	fn := exportFn
	if fn == nil {
		fn = diagnostics.Export
	}
	zipPath, err := fn(opts)
	if err != nil {
		log.Error("diagnostic export failed", "error", err)
		t.exportMu.Lock()
		t.exportProgressPhase = ""
		t.exportFailureMsg = exportItemFailure
		t.exportMu.Unlock()
		// Re-enable so the user can retry. The sticky failure label
		// stays until the next successful export or the next click.
		if t.exportItem != nil {
			t.menuMu.Lock()
			t.exportItem.Enable()
			t.menuMu.Unlock()
		}
		t.updateExportItemLabel()
		return
	}
	log.Info("diagnostic export ok", "path", zipPath)
	if err := revealInFileBrowser(zipPath); err != nil {
		log.Error("reveal diagnostic zip failed", "error", err, "path", zipPath)
		// Reveal failure is non-fatal — the zip exists, we just couldn't
		// pop Finder. Surface it the same way as an export failure so
		// the user sees the launcher.log pointer.
		t.exportMu.Lock()
		t.exportProgressPhase = ""
		t.exportFailureMsg = exportItemFailure
		t.exportMu.Unlock()
		if t.exportItem != nil {
			t.menuMu.Lock()
			t.exportItem.Enable()
			t.menuMu.Unlock()
		}
		t.updateExportItemLabel()
		return
	}
	t.exportMu.Lock()
	t.exportProgressPhase = ""
	t.exportSuccessUntilTS = time.Now().Add(exportSuccessHold)
	t.exportMu.Unlock()
	// Item stays disabled across the success transient; updateExportItemLabel
	// re-enables it when the transient expires.
	t.updateExportItemLabel()
}

// setExportPhase is the ProgressFn callback handed to diagnostics.Export.
// Writes the phase string under the export mutex, then refreshes the
// menu label immediately so phase transitions don't lag the next 2s
// tick. updateExportItemLabel re-acquires exportMu, so the write lock
// must be released before calling it.
func (t *trayController) setExportPhase(phase string) {
	t.exportMu.Lock()
	t.exportProgressPhase = phase
	t.exportMu.Unlock()
	t.updateExportItemLabel()
}
