//go:build !darwin && !windows

package main

import (
	"fmt"
	"os"
	"runtime"
)

// Linux / other-OS stubs so the package builds on the CI runner.
// The only Linux path we exercise today is the autostart-stubs
// commit (see autostart_linux.go); a real Linux GUI dialog is
// out-of-scope for v15. writeStartupErrorLog + startupErrorLogPath
// live in preflight_log.go (shared across platforms).

// showPortInUseDialog logs to stderr and the diagnostic log file
// — Linux build is for CI / future use; no GUI dialog today.
func showPortInUseDialog() {
	exe, _ := os.Executable()
	logPath := writeStartupErrorLog("port-in-use", map[string]string{
		"port": healthServerPort,
		"exe":  exe,
		"os":   runtime.GOOS + "/" + runtime.GOARCH,
	})
	fmt.Fprintf(os.Stderr,
		"friday-launcher: port %s already in use; cannot start. "+
			"Run `lsof -iTCP:%s` to diagnose. Log: %s\n",
		healthServerPort, healthServerPort, logPath)
}
