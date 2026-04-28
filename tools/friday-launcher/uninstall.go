package main

import (
	"fmt"
	"os"
	"time"

	"github.com/friday-platform/friday-studio/pkg/processkit"
)

// runUninstall removes Friday Launcher's OS-level footprint:
//  1. If a launcher is currently running (pid file + alive), send
//     SIGTERM and wait up to 35 s for clean exit.
//  2. Remove the OS autostart entry (LaunchAgent plist on macOS,
//     HKCU registry value on Windows).
//  3. Remove pids/ + state.json.
//
// Logs (~/.friday/local/logs/) are kept by default for diagnostics.
// Idempotent — re-running after a previous --uninstall is safe.
//
// Exits 0 on success, 1 on any error.
func runUninstall() {
	stepFailed := false
	step := func(name string, err error) {
		if err == nil {
			fmt.Printf("  ✓ %s\n", name)
			return
		}
		fmt.Printf("  ✗ %s: %s\n", name, err)
		stepFailed = true
	}

	fmt.Println("friday-launcher uninstall:")

	// 1. Stop running launcher.
	pid, err := readLauncherPid()
	if err == nil && pid > 0 && processkit.ProcessAlive(pid) {
		fmt.Printf("  · stopping running launcher pid=%d\n", pid)
		_ = processkit.Kill(pid, 0)
		// Poll for the lock to free (which means the launcher's
		// onExit ran and removed the pid file). Give it 35 s — same
		// budget as the launcher's own ShutDownProject deadline.
		stopped := false
		for i := 0; i < 35; i++ {
			if !processkit.ProcessAlive(pid) {
				stopped = true
				break
			}
			time.Sleep(time.Second)
		}
		if !stopped {
			step("launcher process exit", fmt.Errorf(
				"pid %d still alive after 35s; remaining cleanup may race", pid))
		} else {
			step("launcher process stopped", nil)
		}
	} else {
		step("launcher already stopped", nil)
	}

	// 2. Remove autostart entry.
	if err := disableAutostart(); err != nil {
		step("remove autostart entry", err)
	} else {
		step("autostart entry removed", nil)
	}

	// 3. Remove pids/ + state.json. Logs are preserved.
	if err := removeIfExists(statePath()); err != nil {
		step("remove state.json", err)
	} else {
		step("state.json removed", nil)
	}

	if err := os.RemoveAll(pidsDir()); err != nil {
		step("remove pids/ directory", err)
	} else {
		step("pids/ directory removed", nil)
	}

	fmt.Println()
	fmt.Printf("Logs preserved at: %s\n", logsDir())
	if stepFailed {
		os.Exit(1)
	}
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
}
