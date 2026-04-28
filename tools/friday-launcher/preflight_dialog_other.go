//go:build !darwin && !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Linux / other-OS stubs so the package builds on the CI runner.
// The only Linux path we exercise today is the autostart-stubs
// commit (see autostart_linux.go); a real Linux GUI dialog is
// out-of-scope for v15.

const startupErrorLogFallback = "friday-launcher-startup.log"

func writeStartupErrorLog(reason string, details map[string]string) string {
	logPath := startupErrorLogPath()
	if logPath == "" {
		return ""
	}
	f, err := os.OpenFile(
		logPath,
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o644,
	)
	if err != nil {
		return ""
	}
	defer f.Close()

	fmt.Fprintf(f, "%s startup error: %s\n",
		time.Now().UTC().Format(time.RFC3339), reason)
	for k, v := range details {
		fmt.Fprintf(f, "  %s: %s\n", k, v)
	}
	fmt.Fprintln(f, "")
	return logPath
}

func startupErrorLogPath() string {
	home, err := os.UserHomeDir()
	if err == nil {
		dir := filepath.Join(home, ".friday", "local", "logs")
		if err := os.MkdirAll(dir, 0o755); err == nil {
			return filepath.Join(dir, "launcher-startup.log")
		}
	}
	tmp := os.TempDir()
	if tmp == "" {
		return ""
	}
	return filepath.Join(tmp, startupErrorLogFallback)
}

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
