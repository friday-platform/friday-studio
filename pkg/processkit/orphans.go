package processkit

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SweepOrphans scans pidDir for *.pid files (skipping launcher.pid),
// reads each, and SIGTERMs any process still alive. Returns the count
// of processes killed.
//
// The pid file format is "<pid> <start_unix>" — one line, two fields.
// Malformed pid files are removed. Files where the recorded pid is no
// longer alive are also removed (best-effort cleanup).
//
// On macOS, where SIGKILL of a parent leaves children orphaned to
// launchd/init, this is the only mechanism that prevents stale
// supervised binaries from holding ports across parent restarts.
//
// On Windows, this is a no-op in practice because the Job Object
// already terminated everything when the parent died.
func SweepOrphans(pidDir string) (killed int, err error) {
	entries, dirErr := os.ReadDir(pidDir)
	if dirErr != nil {
		// Missing dir is fine — first run.
		if os.IsNotExist(dirErr) {
			return 0, nil
		}
		return 0, dirErr
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".pid" {
			continue
		}
		if e.Name() == "launcher.pid" {
			continue
		}
		path := filepath.Join(pidDir, e.Name())
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		pid, _, parseErr := ParsePidFile(data)
		if parseErr != nil {
			_ = os.Remove(path)
			continue
		}
		if ProcessAlive(pid) {
			_ = Kill(pid, 0) // best-effort; SIGTERM only, no escalation
			killed++
		}
		_ = os.Remove(path)
	}
	return killed, nil
}

// ParsePidFile parses the launcher's pid-file format ("<pid>
// <start_unix>"). Used here AND by callers like the launcher itself;
// kept in processkit so any future Go binary wanting to participate
// in the same pid-file convention has a single parser.
func ParsePidFile(data []byte) (pid int, startUnix int64, err error) {
	s := strings.TrimSpace(string(data))
	parts := strings.Fields(s)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("pid file: want 2 fields, got %d", len(parts))
	}
	pid, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("pid file: pid: %w", err)
	}
	startUnix, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("pid file: start: %w", err)
	}
	return pid, startUnix, nil
}
