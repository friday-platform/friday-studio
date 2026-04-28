//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// wakePath returns the location of the sentinel touch file the wake
// path uses on Windows. Lives here (not in paths.go) so it doesn't
// show as unused on macOS/Linux builds.
func wakePath() string { return filepath.Join(friendlyHome(), ".wake") }

// installWakeSignal is a no-op on Windows. The wake-up path on Windows
// uses the sentinel file at ~/.friday/local/.wake — see
// startSentinelWatcher.
func installWakeSignal(onWake func()) {}

// notifyRunningInstance writes a touch file at ~/.friday/local/.wake
// whose presence the running launcher's goroutine D detects on its
// next poll. The pid argument is unused on Windows (no signals).
func notifyRunningInstance(pid int) error {
	stamp := []byte(fmt.Sprintf("%d\n", time.Now().Unix()))
	if err := os.MkdirAll(friendlyHome(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(wakePath(), stamp, 0o644)
}

// startSentinelWatcher polls ~/.friday/local/.wake every 500ms; when
// it appears, deletes it and calls onWake.
func startSentinelWatcher(onWake func()) {
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			if _, err := os.Stat(wakePath()); err == nil {
				_ = os.Remove(wakePath())
				onWake()
			}
		}
	}()
}
