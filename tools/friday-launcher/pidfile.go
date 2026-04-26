package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// pidFileContents formats the pid file body. Format is
// "<pid> <start_time_unix>" so a recycled OS PID can be told apart
// from a real launcher.
func pidFileContents(pid int, startUnix int64) []byte {
	return []byte(fmt.Sprintf("%d %d\n", pid, startUnix))
}

// parsePidFile decodes "<pid> <start_time_unix>"; returns 0,0,err on
// malformed input.
func parsePidFile(data []byte) (pid int, startUnix int64, err error) {
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

// processStartUnix returns the wall-clock unix start time of the
// process with the given pid (used by the start-time verification in
// the installer↔launcher contract). Implemented per platform.
// Returns 0 + error if the pid does not exist.

// readLauncherPid reads launcher.pid, returns the pid + start_time
// recorded in it, or err if the file is missing/malformed.
func readLauncherPid() (pid int, startUnix int64, err error) {
	data, err := os.ReadFile(launcherPidPath())
	if err != nil {
		return 0, 0, err
	}
	return parsePidFile(data)
}
