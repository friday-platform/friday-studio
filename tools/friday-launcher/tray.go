package main

import (
	_ "embed"
	"sync/atomic"
	"time"

	"fyne.io/systray"
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

	currentBucket trayBucket
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

	t.openItem = systray.AddMenuItem("Open in browser", "Open Friday Studio")
	t.restartItem = systray.AddMenuItem("Restart all", "Stop and start every supervised process")
	t.logsItem = systray.AddMenuItem("View logs", "Open ~/.friday/local/logs in your file browser")
	systray.AddSeparator()
	t.autostartItem = systray.AddMenuItemCheckbox(
		"Start at login",
		"Re-launch Friday Studio when you next log in",
		isAutostartEnabled())
	systray.AddSeparator()
	t.quitItem = systray.AddMenuItem("Quit", "Shut down Friday Studio cleanly")

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
	if bucket != t.currentBucket {
		systray.SetTooltip(bucket.tooltip())
		systray.SetTitle(bucket.titleText())
		t.currentBucket = bucket
	}
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
