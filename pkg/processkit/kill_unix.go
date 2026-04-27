//go:build !windows

package processkit

import (
	"syscall"
	"time"
)

// Kill sends SIGTERM to pid, waits up to gracePeriod for the process to
// exit, then SIGKILLs if still alive. gracePeriod=0 means fire SIGTERM
// and return immediately (the legacy launcher orphan-sweep behavior).
//
// Best-effort: errors from kill() are not surfaced because the common
// case (process already gone) is success from the caller's view.
func Kill(pid int, gracePeriod time.Duration) error {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		// ESRCH means the process is already gone — that's success.
		if err == syscall.ESRCH {
			return nil
		}
		return err
	}
	if gracePeriod <= 0 {
		return nil
	}
	deadline := time.Now().Add(gracePeriod)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Still alive past grace — escalate.
	_ = syscall.Kill(pid, syscall.SIGKILL)
	return nil
}

// ProcessAlive returns true if a process with pid is currently
// running and reachable by the current uid. Uses signal 0 (no-op
// signal) which only checks delivery permission.
func ProcessAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
