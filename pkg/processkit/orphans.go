package processkit

import (
	"fmt"
	"os"
	"os/exec"
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
		data, readErr := os.ReadFile(path) //nolint:gosec // G304: pidDir is process-internal, not user input
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

// SweepByBinaryPath kills any process (other than the caller) whose
// executable path starts with binaryDir. Defense-in-depth for the
// "pid files missing but child processes still alive" case — e.g.
// after `rm -rf ~/.friday/local` while the launcher is running, or
// after a SIGKILL'd launcher whose pid files got truncated. Returns
// the number of survivors killed.
//
// Best-effort: if the OS-specific scan fails (e.g. ps not on PATH),
// returns 0 + error and the caller carries on with the standard
// pid-file sweep.
func SweepByBinaryPath(binaryDir string) (killed int, err error) {
	binaryDir = filepath.Clean(binaryDir)
	if binaryDir == "" || binaryDir == "/" {
		return 0, fmt.Errorf("refusing to sweep dir %q", binaryDir)
	}
	pids, err := scanProcessesByBinaryPath(binaryDir)
	if err != nil {
		return 0, err
	}
	self := os.Getpid()
	for _, pid := range pids {
		if pid == self {
			continue
		}
		if !ProcessAlive(pid) {
			continue
		}
		_ = Kill(pid, 0)
		killed++
	}
	return killed, nil
}

// scanProcessesByBinaryPath returns PIDs whose executable path lies
// under binaryDir. Implemented via `ps` on Unix; on Windows the
// Job Object handles this case so this is a no-op stub.
func scanProcessesByBinaryPath(binaryDir string) ([]int, error) {
	// `ps -eo pid=,comm=` returns "PID PATH" per line. We compare PATH
	// (the program path, NOT the full command line) against binaryDir
	// to avoid false positives from grep-style matches in args.
	cmd := exec.Command("ps", "-eo", "pid=,comm=")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ps: %w", err)
	}
	prefix := binaryDir
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Split on first whitespace: "<pid> <path>"
		i := strings.IndexAny(line, " \t")
		if i <= 0 {
			continue
		}
		pidStr := strings.TrimSpace(line[:i])
		pathStr := strings.TrimSpace(line[i:])
		if !strings.HasPrefix(pathStr, prefix) {
			continue
		}
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	return pids, nil
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
