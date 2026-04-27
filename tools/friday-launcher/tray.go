package main

import (
	_ "embed"
	"sync/atomic"
	"time"

	"fyne.io/systray"
)

//go:embed assets/tray-friday.png
var iconFriday []byte

// trayBucket represents the rendered status — used for the menu's
// status text + tooltip. The tray *icon* itself is always the Friday
// logo regardless of state; status is conveyed in the first menu
// item's text instead.
type trayBucket int

const (
	bucketAmber trayBucket = iota // default while starting up
	bucketGreen
	bucketRed
	bucketGrey // shutting down
)

func (b trayBucket) statusText() string {
	switch b {
	case bucketGreen:
		return "Status: Running"
	case bucketRed:
		return "Status: Error"
	case bucketGrey:
		return "Status: Shutting down…"
	default:
		return "Status: Starting…"
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
	statusItem    *systray.MenuItem
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
	systray.SetIcon(iconFriday)
	systray.SetTitle("")
	systray.SetTooltip("Friday Studio — starting…")

	// Status text is a disabled (un-clickable) item at the top so users
	// see the current health state at a glance. Updated by tick().
	t.statusItem = systray.AddMenuItem(bucketAmber.statusText(), "")
	t.statusItem.Disable()
	systray.AddSeparator()
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
			openInFileBrowser(logsDir())
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
		if t.statusItem != nil {
			t.statusItem.SetTitle(bucket.statusText())
		}
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
