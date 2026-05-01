//go:build windows

package processkit

import (
	"strconv"
	"time"

	"golang.org/x/sys/windows"
)

// Kill terminates pid via TerminateProcess. The gracePeriod is honored
// only as far as a tight poll loop calling ProcessAlive between
// TerminateProcess calls — Windows has no "polite signal" equivalent
// of SIGTERM, so the practical contract is "ask once, force-kill if
// still alive at the end."
//
// Best-effort: errors are not surfaced.
func Kill(pid int, gracePeriod time.Duration) error {
	terminate(pid)
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
	terminate(pid) // second-chance escalation; same call, but caller asked
	return nil
}

func terminate(pid int) {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_ = windows.TerminateProcess(h, 1)
}

// ProcessAlive returns true if a process with pid is currently running.
// Uses OpenProcess with QUERY_LIMITED_INFORMATION which the user owning
// the process is always permitted to do.
func ProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}

// pidStr is a tiny helper kept so the windows file imports strconv
// alongside windows; useful if a caller wants to log the pid.
func pidStr(pid int) string { return strconv.Itoa(pid) }
