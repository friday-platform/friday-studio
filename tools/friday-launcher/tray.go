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

	openedBrowserOnce atomic.Bool

	// menu items kept around so we can update labels / disable / enable
	openItem      *systray.MenuItem
	restartItem   *systray.MenuItem
	logsItem      *systray.MenuItem
	autostartItem *systray.MenuItem
	quitItem      *systray.MenuItem

	currentBucket trayBucket
}

func newTrayController(sup *Supervisor, shuttingDown *atomic.Bool) *trayController {
	return &trayController{sup: sup, shuttingDown: shuttingDown}
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

// computeBucket implements the Tray Color Matrix.
func (t *trayController) computeBucket() trayBucket {
	if t.shuttingDown.Load() {
		return bucketGrey
	}
	if t.sup.SupervisorExited() {
		return bucketRed
	}
	state, err := t.sup.State()
	if err != nil || state == nil {
		return bucketAmber
	}
	if state.IsReady() && len(state.States) > 0 {
		return bucketGreen
	}
	// Cold-start grace: stay amber regardless of "looks broken" signals
	// for the first 30 s.
	if time.Since(t.sup.StartedAt()) < 30*time.Second {
		return bucketAmber
	}
	// Past grace: any process in Error, or restarting >= max → RED.
	for _, ps := range state.States {
		if ps.Status == "Error" {
			return bucketRed
		}
	}
	return bucketAmber
}

func (t *trayController) openBrowser(reason string) {
	// --no-browser is an absolute kill-switch: every code path that would
	// otherwise open the browser bails out here. Critical for `go test`,
	// which boots the launcher subprocess with the flag and would
	// otherwise pop tabs on the developer's machine.
	if noBrowser {
		log.Info("browser-open suppressed by --no-browser", "reason", reason)
		return
	}
	const url = "http://localhost:5200"
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
