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
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"fyne.io/systray"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"gopkg.in/natefinch/lumberjack.v2"
)

// noBrowser is set from --no-browser; controls the auto-open behavior
// when all processes report ready. Stored as a package-level var
// because the tray controller needs to consult it from goroutines
// that don't have a reference to the parsed flag set.
var noBrowser bool

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
var jobHandle *jobObject

func main() {
	autostartCmd, uninstall := parseFlags()
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
		log.Fatal().Err(err).Msg("acquirePidLock fatal error")
	}
	if !ok {
		// Another launcher is running. Read its pid + wake it.
		if pid, _, err := readLauncherPid(); err == nil {
			log.Info().Int("running_pid", pid).
				Msg("another launcher detected; sending wake")
			if err := notifyRunningInstance(pid); err != nil {
				log.Warn().Err(err).Msg("failed to notify running launcher")
			}
		}
		os.Exit(0)
	}
	pidLock = lock
	if err := pidLock.writePid(os.Getpid(), time.Now().Unix()); err != nil {
		log.Fatal().Err(err).Msg("writePid")
	}

	// Best-effort: clean up orphan supervised processes from a prior
	// SIGKILL'd launcher (Unix only — Windows Job Object handles it).
	cleanupOrphanedChildren()

	// Hard-kill resilience: assign self to a Job Object on Windows so
	// children die with us. No-op on Unix.
	jobHandle, err = attachSelfToJob()
	if err != nil {
		log.Warn().Err(err).Msg("attachSelfToJob (non-fatal)")
	}

	setupSignalHandlers()

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
	return
}

func setupLogging() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	rotator := &lumberjack.Logger{
		Filename:   launcherLogPath(),
		MaxSize:    10, // MB
		MaxBackups: 3,
		Compress:   false,
	}
	// Write to BOTH stderr and the rotated file so dev runs see logs
	// in the terminal AND production runs persist them.
	log.Logger = zerolog.New(zerolog.MultiLevelWriter(
		zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339},
		rotator,
	)).With().Timestamp().Logger()
	log.Info().Str("pid", fmt.Sprintf("%d", os.Getpid())).
		Str("bin_dir", binDir).
		Bool("no_browser", noBrowser).
		Msg("friday-launcher starting")
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
		log.Info().Stringer("signal", sig).Msg("shutdown signal received")
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
			log.Warn().Err(err).Msg("autostart self-register (non-fatal)")
		}
	}()

	// Build project + supervisor.
	specs := supervisedProcesses(binDir)
	project := newProjectFromSpecs(specs)
	sup, err := NewSupervisor(project, &shuttingDown)
	if err != nil {
		log.Fatal().Err(err).Msg("NewSupervisor")
	}
	supervisor = sup

	// Goroutine A: wraps runner.Run() with watchdog.
	go sup.runAndWatch()

	// Tray controller (goroutine B + click handlers).
	trayCtl = newTrayController(sup, &shuttingDown)
	trayCtl.onReady()

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

// performShutdown is the single source of truth for the orderly
// shutdown path. Idempotent: a second caller is a no-op.
//
// Split-shutdown semantics: flip shuttingDown so the tray-poll
// goroutine can render "Shutting down…" grey, kick off
// ShutDownProject in a goroutine, wait on a done channel with a 30 s
// safety deadline so we never hang forever even if a child binary
// ignores SIGTERM.
func performShutdown(reason string) {
	if !shutdownStarted.CompareAndSwap(false, true) {
		return // another caller beat us; let them finish
	}
	log.Info().Str("reason", reason).Msg("performShutdown starting")
	shuttingDown.Store(true)
	if supervisor == nil {
		releasePidLock()
		closeJob()
		return
	}
	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(
		context.Background(), 30*time.Second)
	defer cancel()
	go func() {
		log.Info().Msg("ShutDownProject starting")
		if err := supervisor.Shutdown(); err != nil {
			log.Err(err).Msg("ShutDownProject")
		}
		close(done)
	}()
	select {
	case <-done:
		log.Info().Msg("ShutDownProject completed")
	case <-ctx.Done():
		log.Warn().Msg("ShutDownProject did not complete in 30s; exiting anyway")
	}
	releasePidLock()
	closeJob()
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
		log.Info().Str("exe", exe).
			Msg("first-run autostart self-register")
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
		log.Info().Str("registered", registered).Str("current", exe).
			Msg("autostart path stale; rewriting")
		if err := enableAutostart(); err != nil {
			return fmt.Errorf("enableAutostart (staleness): %w", err)
		}
	}
	return nil
}
