//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// installWakeSignal listens for SIGUSR1 and invokes onWake whenever it
// arrives. SIGUSR1 is sent by a second-instance launcher process (see
// notifyRunningInstance) when a Dock click / Spotlight relaunch
// happens — the running launcher should pop the browser.
func installWakeSignal(onWake func()) {
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGUSR1)
	go func() {
		for range ch {
			onWake()
		}
	}()
}

// notifyRunningInstance signals the running launcher (whose pid is in
// pidFile) to wake — opens the browser, brings tray to front, etc.
// On Unix this is SIGUSR1.
func notifyRunningInstance(pid int) error {
	return syscall.Kill(pid, syscall.SIGUSR1)
}

// startSentinelWatcher is a no-op on Unix; the SIGUSR1 path covers
// the same use case.
func startSentinelWatcher(onWake func()) {}
