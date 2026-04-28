// Package main is the friday-launcher binary. See
// docs/plans/2026-04-25-friday-launcher-design.v8.md for the full
// architectural rationale; this top-level file only ties the pieces
// together and follows the mandatory main() shape from that plan
// (parseFlags → setupLogging → setupSignalHandlers → systray.Run last).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"fyne.io/systray"
	"github.com/friday-platform/friday-studio/pkg/logger"
	"github.com/friday-platform/friday-studio/pkg/processkit"
	"gopkg.in/natefinch/lumberjack.v2"
)

// log is the package-level Logger used across the launcher's files.
// Initialized at package-init so tests don't nil-deref before
// setupLogging runs. main() reassigns it to a writer that fans out
// to both stderr and a lumberjack-rotated launcher.log.
var log = logger.New("friday-launcher")

// noBrowser is set from --no-browser; suppresses the auto-open on
// the first-healthy transition. User-initiated opens (tray click,
// second-instance wake) are NOT affected — those always open the
// browser even with --no-browser, because silently doing nothing in
// response to a click is worse UX than honoring the flag would buy.
// Stored as a package-level var because the tray controller needs
// to consult it from goroutines that don't have a reference to the
// parsed flag set.
var noBrowser bool

// browserDisabled is an INTERNAL kill-switch set from the
// FRIDAY_LAUNCHER_BROWSER_DISABLED env var. Unlike --no-browser,
// this absolutely suppresses every openBrowser call regardless of
// reason. Used by integration tests so spawning the launcher
// subprocess in `go test` doesn't pop browser tabs on the
// developer's machine, even when the test exercises tray-click /
// second-instance-wake paths. Not documented in CLI help — internal
// only.
var browserDisabled bool

// binDir is set from --bin-dir; defaults to the launcher's own
// directory (so the launcher and supervised binaries co-locate in
// the platform tarball). Tests use this to point at stub binaries.
var binDir string

// shuttingDown is the global atomic flag flipped by onExit (and by
// the signal handler). Used by the tray-poll goroutine to render
// "Shutting down…" grey, and by the supervisor watchdog to
// distinguish "we initiated shutdown" from "Run() exited
// unexpectedly".
var shuttingDown atomic.Bool

// shutdownStarted ensures performShutdown() runs at most once even
// if both the signal handler AND onExit fire (fyne-io/systray's
// onExit only runs reliably when there's a Cocoa NSApp; running the
// launcher from a non-app context — e.g. headless / CI / SSH without
// proper bootstrap — means onExit may not fire and the signal handler
// becomes the sole shutdown driver).
var shutdownStarted atomic.Bool

// supervisor is set in onReady after we've confirmed we hold the
// pid-file lock. Used by the signal handler (orderly shutdown) and
// by the tray controller.
var supervisor *Supervisor

// trayCtl is created in onReady. Used by the wake handlers to open
// the browser bypassing the once-per-session guard.
var trayCtl *trayController

// pidLock is the OS file handle holding our exclusive flock on
// launcher.pid. Released in onExit after ShutDownProject completes.
var pidLock *pidFileLock

// jobHandle (Windows only) keeps the Job Object alive for the
// lifetime of the launcher; close-on-exit kills every supervised
// child via KILL_ON_JOB_CLOSE. No-op on Unix.
var jobHandle *processkit.JobObject

// healthCache is the launcher's per-service status record + SSE
// fan-out hub. Created in main() before systray.Run so the bind
// error on port 5199 surfaces via the osascript dialog (Decision
// #28) before the tray boots. Read by tray bucket logic, GET +
// SSE handlers, and the POST shutdown handler's 409 probe.
var healthCache *HealthCache

// healthSrv is the http.Server backing /api/launcher-health[/stream]
// and /api/launcher-shutdown. Closed as the LAST step of
// performShutdown (after sweep, before releasePidLock) per
// Decision #18 lifecycle.
var healthSrv *http.Server

// healthPollCancel cancels the 500ms-poll goroutine created in
// onReady once the supervisor exists. Called from performShutdown
// before supervisor.Shutdown so the goroutine doesn't observe a
// torn-down supervisor mid-poll.
var healthPollCancel context.CancelFunc

func main() {
	autostartCmd, uninstall := parseFlags()
	// Internal test override — see browserDisabled comment.
	browserDisabled = os.Getenv("FRIDAY_LAUNCHER_BROWSER_DISABLED") == "1"
	if err := ensureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "friday-launcher: %s\n", err)
		os.Exit(1)
	}
	setupLogging()

	// --autostart {enable|disable|status} runs as a one-shot CLI,
	// no tray. Useful for headless setup + scripting.
	if autostartCmd != "" {
		runAutostartCommand(autostartCmd)
		return
	}

	// --uninstall: stop any running launcher, remove autostart entry,
	// remove pids/ + state.json. Logs preserved by default.
	if uninstall {
		runUninstall()
		return
	}

	// Single-instance handshake: try the flock. If it fails, signal
	// the running launcher and exit.
	lock, ok, err := acquirePidLock()
	if err != nil {
		log.Fatal("acquirePidLock fatal error", "error", err)
	}
	if !ok {
		// Another launcher is running. Read its pid + wake it.
		if pid, err := readLauncherPid(); err == nil {
			log.Info("another launcher detected; sending wake", "running_pid", pid)
			if err := notifyRunningInstance(pid); err != nil {
				log.Warn("failed to notify running launcher", "error", err)
			}
		}
		os.Exit(0)
	}
	pidLock = lock
	if err := pidLock.writePid(os.Getpid(), time.Now().Unix()); err != nil {
		log.Fatal("writePid", "error", err)
	}

	// Best-effort: clean up orphan supervised processes from a prior
	// SIGKILL'd launcher (Unix only — Windows Job Object handles it).
	// Two passes:
	//   1. Pid-file sweep (the normal case: pids/ has stale entries).
	//   2. Binary-path sweep — defense-in-depth for the case where
	//      pid files are MISSING but children are still alive (e.g.
	//      `rm -rf ~/.friday/local` between SIGKILL and restart, or
	//      a fresh install over an installation that's still running).
	if killed, err := processkit.SweepOrphans(pidsDir()); err != nil {
		log.Warn("SweepOrphans (non-fatal)", "error", err)
	} else if killed > 0 {
		log.Info("swept orphaned supervised processes (pid-file)", "killed", killed)
	}
	if killed, err := processkit.SweepByBinaryPath(binDir); err != nil {
		log.Warn("SweepByBinaryPath (non-fatal)", "error", err)
	} else if killed > 0 {
		log.Info("swept orphaned supervised processes (binary-path)", "killed", killed)
	}

	// Hard-kill resilience: assign self to a Job Object on Windows so
	// children die with us. No-op on Unix.
	jobHandle, err = processkit.AttachSelfToJob()
	if err != nil {
		log.Warn("AttachSelfToJob (non-fatal)", "error", err)
	}

	setupSignalHandlers()

	// Bind the health server BEFORE systray.Run so a port-5199
	// collision surfaces via the osascript dialog (Decision #28)
	// before the tray boots — same UX as pre-flight failures
	// (Stack 3 will add missing-binaries here too). HealthCache
	// itself is created with the global &shuttingDown atomic per
	// Decision #33; the poll goroutine that fills the cache is
	// spawned in onReady once supervisor exists.
	healthCache = NewHealthCache(&shuttingDown)
	srv, err := startHealthServer(healthCache, performShutdown)
	if err != nil {
		log.Error("startHealthServer", "error", err)
		showPortInUseDialog()
		os.Exit(1)
	}
	healthSrv = srv

	// systray.Run BLOCKS on macOS NSApp event loop. Everything else
	// must spawn from onReady.
	systray.Run(onReady, onExit)
}

func parseFlags() (autostart string, uninstall bool) {
	flag.BoolVar(&noBrowser, "no-browser", false,
		"do not auto-open the browser when supervised processes report ready")
	flag.StringVar(&binDir, "bin-dir", "",
		"directory containing supervised binaries (defaults to launcher's own dir)")
	flag.StringVar(&autostart, "autostart", "",
		"enable|disable|status — manage OS autostart entry then exit")
	flag.BoolVar(&uninstall, "uninstall", false,
		"stop any running launcher, remove the OS autostart entry, "+
			"and clean up pids + state. Logs preserved.")
	flag.Parse()

	if binDir == "" {
		exe, err := os.Executable()
		if err == nil {
			binDir = filepath.Dir(exe)
		}
	}
	return autostart, uninstall
}

func setupLogging() {
	rotator := &lumberjack.Logger{
		Filename:   launcherLogPath(),
		MaxSize:    10, // MB
		MaxBackups: 3,
		Compress:   false,
	}
	// Write to BOTH stderr and the rotated file so dev runs see logs
	// in the terminal AND production runs persist them.
	log = logger.NewWithWriter("friday-launcher",
		io.MultiWriter(os.Stderr, rotator))
	log.Info("friday-launcher starting",
		"pid", os.Getpid(),
		"bin_dir", binDir,
		"no_browser", noBrowser,
	)
}

func setupSignalHandlers() {
	// SIGTERM / SIGINT → orderly shutdown.
	// Both the signal handler AND onExit drive performShutdown(); the
	// shutdownStarted atomic guarantees the work runs exactly once.
	// We do NOT rely on systray.Quit() → onExit → shutdown alone
	// because fyne-io/systray's onExit may not fire reliably when the
	// launcher runs outside a Cocoa NSApp context (e.g. SSH,
	// systemd-spawned, CI). The signal-handler path is the
	// always-reliable shutdown driver; onExit is a backup that runs
	// when the user clicks "Quit" in the tray menu.
	go func() {
		ch := make(chan os.Signal, 4)
		signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
		sig := <-ch
		log.Info("shutdown signal received", "signal", sig.String())
		performShutdown("signal:" + sig.String())
		systray.Quit() // unblocks main; onExit may also fire (idempotent)
	}()

	// SIGUSR1 (Unix) → wake-up: open browser. Routed through the
	// tray controller so the once-per-session guard is bypassed
	// correctly.
	installWakeSignal(func() {
		if trayCtl != nil {
			trayCtl.wakeFromSecondInstance()
		}
	})
}

func onReady() {
	// State.json + autostart self-registration + staleness repair.
	go func() {
		if err := autostartSelfRegister(); err != nil {
			log.Warn("autostart self-register (non-fatal)", "error", err)
		}
	}()

	// Build project + supervisor.
	specs := supervisedProcesses(binDir)
	project := newProjectFromSpecs(specs)
	sup, err := NewSupervisor(project, &shuttingDown)
	if err != nil {
		log.Fatal("NewSupervisor", "error", err)
	}
	supervisor = sup

	// Goroutine A: wraps runner.Run() with watchdog.
	go sup.runAndWatch()

	// Goroutine F: 500ms-poll cache update. Reads supervisor.State()
	// and pushes into healthCache. Cancelled in performShutdown
	// before supervisor.Shutdown so the goroutine doesn't observe a
	// torn-down supervisor mid-poll. Per Decision #18 lifecycle the
	// HTTP server itself stays up across Restart-all and only closes
	// in performShutdown's last step.
	// pollCancel is stored in the package-level healthPollCancel
	// and called from performShutdown; gosec G118 doesn't trace
	// through the package-var assignment, hence the nolint.
	pollCtx, pollCancel := context.WithCancel(context.Background()) //nolint:gosec // G118: cancel stored in healthPollCancel
	healthPollCancel = pollCancel
	go runHealthPoll(pollCtx, sup, healthCache)

	// Tray controller (goroutine B + click handlers). healthCache
	// drives the bucket logic per Decision #4 — the existing
	// state.IsReady() heuristic is gone.
	trayCtl = newTrayController(sup, &shuttingDown, healthCache)
	trayCtl.onReady()

	// Register the NSApp will-terminate observer so external
	// termination (system shutdown, force-quit, OS-level kill)
	// gets a chance to drive performShutdown synchronously
	// (Decision #13). No-op on Linux/Windows. MUST be after
	// systray.Run brought NSApp up — i.e. inside onReady.
	registerNSAppWillTerminate()

	// Goroutine D: sentinel-file watcher (Windows only; no-op on Unix).
	startSentinelWatcher(func() {
		if trayCtl != nil {
			trayCtl.wakeFromSecondInstance()
		}
	})
}

// onExit is invoked synchronously on the macOS NSApp event loop
// thread when systray.Quit fires (e.g. tray-menu "Quit" click). Must
// return promptly so the OS doesn't think the launcher hung. Drives
// performShutdown() as backup — the signal handler is the primary
// shutdown driver. performShutdown is idempotent.
func onExit() {
	performShutdown("systray:onExit")
}

// shutdownGate is the CAS one-shot gate that protects
// performShutdown's body from running more than once across all
// trigger paths (signal handler, onExit, HTTP POST, NSApp
// will-terminate). Returns true to the FIRST caller, false to all
// subsequent callers — they must return without performing cleanup.
//
// Two atomics, by design (see CLAUDE.md "two-atomic shutdown
// pattern" + Decision #33):
//   - shutdownStarted: one-shot CAS — winner runs cleanup
//   - shuttingDown: visibility flag — read by tray-poll, HTTP
//     handlers (503 + 409), and the SSE shutting_down field
//
// Extracted from performShutdown so the exactly-once invariant is
// independently testable; performShutdown's body is too entangled
// with real subprocess teardown to drive from a test directly.
func shutdownGate(reason string) bool {
	if !shutdownStarted.CompareAndSwap(false, true) {
		return false
	}
	log.Info("performShutdown starting", "reason", reason)
	shuttingDown.Store(true)
	return true
}

// performShutdown is the single source of truth for the orderly
// shutdown path. Idempotent: a second caller is a no-op.
//
// Split-shutdown semantics: flip shuttingDown so the tray-poll
// goroutine can render "Shutting down…" grey, kick off
// ShutDownProject in a goroutine, wait on a done channel with a 30 s
// safety deadline so we never hang forever even if a child binary
// ignores SIGTERM.
//
// Lifecycle (Decision #18 + cross-cutting §):
//  1. shutdownStarted CAS gate (one-shot for ALL trigger paths —
//     signal handler, onExit, HTTP POST shutdown). Decision #33.
//  2. shuttingDown.Store(true) — visibility flag the tray-poll
//     goroutine + HTTP /api/launcher-health 503 + 409 conflict
//     probe all read.
//  3. cancel healthPoll goroutine (so it doesn't observe a torn-
//     down supervisor mid-poll).
//  4. supervisor.Shutdown() with 30s deadline.
//  5. processkit.SweepByBinaryPath(binDir) — Decision #5: catch
//     orphans whose parent died externally even when the SIGTERM
//     cascade didn't propagate.
//  6. healthSrv.Shutdown(ctx) with 2s deadline — LAST step, after
//     sweep so the wizard during update flow keeps seeing
//     /api/launcher-health (503 + shutting_down: true) until
//     teardown is complete.
//  7. releasePidLock + closeJob.
func performShutdown(reason string) {
	if !shutdownGate(reason) {
		return // another caller beat us; let them finish
	}

	// Stop the cache-update goroutine before tearing down the
	// supervisor it polls. Best-effort: nil-check because
	// performShutdown can run from the signal handler before
	// onReady has executed (e.g. SIGTERM during single-instance
	// sweep / before supervisor exists).
	if healthPollCancel != nil {
		healthPollCancel()
	}

	if supervisor == nil {
		shutdownHealthServer()
		releasePidLock()
		closeJob()
		return
	}
	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(
		context.Background(), 30*time.Second)
	defer cancel()
	go func() {
		log.Info("ShutDownProject starting")
		if err := supervisor.Shutdown(); err != nil {
			log.Error("ShutDownProject", "error", err)
		}
		close(done)
	}()
	select {
	case <-done:
		log.Info("ShutDownProject completed")
	case <-ctx.Done():
		log.Warn("ShutDownProject did not complete in 30s; exiting anyway")
	}

	// Post-shutdown sweep (Decision #5). Catches orphans whose
	// parent process-compose lost track of (Deno workers spawned
	// by friday/link, or anything that ignored SIGTERM). Best-
	// effort: log + continue on error.
	if killed, err := processkit.SweepByBinaryPath(binDir); err != nil {
		log.Warn("post-shutdown SweepByBinaryPath (non-fatal)",
			"error", err)
	} else if killed > 0 {
		log.Info("post-shutdown sweep killed orphans",
			"count", killed)
	}

	shutdownHealthServer()
	releasePidLock()
	closeJob()

	// Unblock systray.Run so main() can return. Required for
	// trigger paths that didn't enter through systray itself
	// (HTTP /api/launcher-shutdown, NSApp will-terminate, signal
	// handler — though the signal handler calls Quit externally
	// too as a backup, double-call is safe per systray's contract).
	// For the systray-Quit-menu path, performShutdown ran from
	// inside onExit which itself was called by systray.Quit; the
	// re-entry here is a no-op.
	systray.Quit()
}

// shutdownHealthServer closes the loopback HTTP listener with a
// short deadline. Called LAST in performShutdown (after sweep)
// per Decision #18 so polling clients keep seeing the 503 +
// shutting_down: true response until the listener actually drops.
func shutdownHealthServer() {
	if healthSrv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(
		context.Background(), 2*time.Second)
	defer cancel()
	if err := healthSrv.Shutdown(ctx); err != nil {
		log.Warn("health HTTP server shutdown", "error", err)
	}
}

func releasePidLock() {
	if pidLock != nil {
		pidLock.release()
		pidLock = nil
	}
}

func closeJob() {
	if jobHandle != nil {
		_ = jobHandle.Close()
		jobHandle = nil
	}
}

// runAutostartCommand handles the --autostart enable|disable|status
// CLI mode. Exits the process when done.
func runAutostartCommand(cmd string) {
	switch cmd {
	case "enable":
		if err := enableAutostart(); err != nil {
			fmt.Fprintf(os.Stderr, "enable: %s\n", err)
			os.Exit(1)
		}
		// Mark state so goroutine E doesn't redo the work next launch.
		_ = writeState(launcherState{AutostartInitialized: true})
		fmt.Println("autostart enabled")
	case "disable":
		if err := disableAutostart(); err != nil {
			fmt.Fprintf(os.Stderr, "disable: %s\n", err)
			os.Exit(1)
		}
		fmt.Println("autostart disabled")
	case "status":
		if isAutostartEnabled() {
			fmt.Println("enabled")
		} else {
			fmt.Println("disabled")
		}
	default:
		fmt.Fprintf(os.Stderr,
			"unknown --autostart command %q (want enable|disable|status)\n", cmd)
		os.Exit(2)
	}
}

// autostartSelfRegister implements goroutine E: first-run
// registration AND staleness repair on every launcher startup.
//
// Two cases:
//  1. state.json absent or autostart_initialized != true → write the
//     OS autostart entry pointing at os.Executable(), set the flag.
//  2. state.json says we're initialized → still compare currentAutostartPath()
//     to os.Executable(); if they differ (user moved the binary),
//     rewrite the entry. State.json stays unchanged.
func autostartSelfRegister() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	state := readState()
	if !state.AutostartInitialized {
		log.Info("first-run autostart self-register", "exe", exe)
		if err := enableAutostart(); err != nil {
			return fmt.Errorf("enableAutostart: %w", err)
		}
		state.AutostartInitialized = true
		if err := writeState(state); err != nil {
			return fmt.Errorf("writeState: %w", err)
		}
		return nil
	}
	// Already initialized — staleness repair pass.
	registered := currentAutostartPath()
	if registered != "" && registered != exe {
		log.Info("autostart path stale; rewriting",
			"registered", registered, "current", exe)
		if err := enableAutostart(); err != nil {
			return fmt.Errorf("enableAutostart (staleness): %w", err)
		}
	}
	return nil
}
