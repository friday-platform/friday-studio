//go:build !windows

package main

import (
	"os"
	"syscall"
)

// pidFileLock holds the OS file handle + advisory flock on the pid
// file. Releasing the *os.File via Close releases the flock too.
type pidFileLock struct {
	f *os.File
}

// acquirePidLock tries to take an EXCLUSIVE non-blocking advisory lock
// on launcher.pid. Returns (lock, true, nil) on success, (nil, false,
// nil) if another process holds the lock, or (nil, false, err) on
// I/O errors.
func acquirePidLock() (*pidFileLock, bool, error) {
	if err := os.MkdirAll(pidsDir(), 0o750); err != nil {
		return nil, false, err
	}
	f, err := os.OpenFile(launcherPidPath(),
		os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, err
	}
	if err := syscall.Flock(int(f.Fd()),
		syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if err == syscall.EWOULDBLOCK {
			return nil, false, nil
		}
		return nil, false, err
	}
	return &pidFileLock{f: f}, true, nil
}

// writePid writes the standard "<pid> <start_unix>" to the locked
// file (truncating any prior contents).
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

// release closes the file (and thus the flock) and removes the pid
// file. Best-effort; errors are ignored on shutdown.
func (l *pidFileLock) release() {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
	_ = os.Remove(launcherPidPath())
}
