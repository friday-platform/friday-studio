package main

import (
	"fmt"
	"os"

	"github.com/tempestteam/atlas/pkg/processkit"
)

// pidFileContents formats the pid file body. Format is
// "<pid> <start_time_unix>" so a recycled OS PID can be told apart
// from a real launcher. The format is owned by pkg/processkit, which
// also exposes the parser.
func pidFileContents(pid int, startUnix int64) []byte {
	return []byte(fmt.Sprintf("%d %d\n", pid, startUnix))
}

// readLauncherPid reads launcher.pid, returns the pid + start_time
// recorded in it, or err if the file is missing/malformed.
func readLauncherPid() (pid int, startUnix int64, err error) {
	data, err := os.ReadFile(launcherPidPath())
	if err != nil {
		return 0, 0, err
	}
	return processkit.ParsePidFile(data)
}
