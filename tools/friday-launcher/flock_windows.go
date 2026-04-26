//go:build windows

package main

import (
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

type pidFileLock struct {
	f      *os.File
	handle windows.Handle
}

func acquirePidLock() (*pidFileLock, bool, error) {
	if err := os.MkdirAll(pidsDir(), 0o755); err != nil {
		return nil, false, err
	}
	f, err := os.OpenFile(launcherPidPath(),
		os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, err
	}
	h := windows.Handle(f.Fd())
	overlapped := &windows.Overlapped{}
	err = windows.LockFileEx(h,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, overlapped)
	if err != nil {
		_ = f.Close()
		// ERROR_LOCK_VIOLATION = 33; treated as "another process has it".
		if err == windows.ERROR_LOCK_VIOLATION || err == windows.ERROR_IO_PENDING {
			return nil, false, nil
		}
		return nil, false, nil
	}
	return &pidFileLock{f: f, handle: h}, true, nil
}

func (l *pidFileLock) writePid(pid int, startUnix int64) error {
	if err := l.f.Truncate(0); err != nil {
		return err
	}
	if _, err := l.f.Seek(0, 0); err != nil {
		return err
	}
	_, err := l.f.Write(pidFileContents(pid, startUnix))
	return err
}

func (l *pidFileLock) release() {
	if l.f != nil {
		overlapped := &windows.Overlapped{}
		_ = windows.UnlockFileEx(l.handle, 0, 1, 0, overlapped)
		_ = l.f.Close()
		l.f = nil
	}
	_ = os.Remove(launcherPidPath())
}

// processStartUnix returns the start time of a process via
// GetProcessTimes. On error returns 0.
func processStartUnix(pid int) (int64, error) {
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, fmt.Errorf("open pid %d: %w", pid, err)
	}
	defer windows.CloseHandle(h)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h,
		&creation, &exit, &kernel, &user); err != nil {
		return 0, err
	}
	return time.Unix(0, creation.Nanoseconds()).Unix(), nil
}

func processAlive(pid int) bool {
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}
