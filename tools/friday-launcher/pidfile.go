package main

import (
	"fmt"
	"os"

	"github.com/friday-platform/friday-studio/pkg/processkit"
)

// pidFileContents formats the pid file body. Format is
// "<pid> <start_time_unix>" so a recycled OS PID can be told apart
// from a real launcher. The format is owned by pkg/processkit, which
// also exposes the parser.
func pidFileContents(pid int, startUnix int64) []byte {
	return []byte(fmt.Sprintf("%d %d\n", pid, startUnix))
}

// readLauncherPid reads launcher.pid and returns the pid recorded in
// it, or err if the file is missing/malformed. The start_time stored
// alongside is dropped — current callers only need the pid.
func readLauncherPid() (int, error) {
	data, err := os.ReadFile(launcherPidPath())
	if err != nil {
		return 0, err
	}
	pid, _, err := processkit.ParsePidFile(data)
	return pid, err
}
