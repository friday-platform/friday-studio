//go:build !windows

package main

import "syscall"

// killProcess sends SIGTERM (then SIGKILL after a short grace) to pid.
// Best-effort; errors are not surfaced.
func killProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
}
