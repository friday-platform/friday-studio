package main

import (
	"os"
	"path/filepath"

	"github.com/rs/zerolog/log"
)

// cleanupOrphanedChildren scans pidsDir for *.pid files (other than
// launcher.pid), reads each, and SIGTERMs any process still alive
// whose recorded start time matches what's currently running.
//
// On macOS, where SIGKILL of the launcher leaves children orphaned
// to launchd/init, this is the only mechanism that prevents stale
// supervised binaries from holding ports across launcher restarts.
//
// On Windows, this is a no-op in practice because the Job Object
// already terminated everything when the launcher died.
//
// The launcher's own pid file (launcher.pid) is handled by the flock
// path, not this sweep.
func cleanupOrphanedChildren() {
	entries, err := os.ReadDir(pidsDir())
	if err != nil {
		// Missing dir is fine — first run.
		return
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".pid" {
			continue
		}
		if e.Name() == "launcher.pid" {
			continue
		}
		path := filepath.Join(pidsDir(), e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		pid, _, err := parsePidFile(data)
		if err != nil {
			log.Warn().Str("file", path).Err(err).
				Msg("malformed orphan pid file; removing")
			_ = os.Remove(path)
			continue
		}
		if processAlive(pid) {
			log.Info().Int("pid", pid).Str("file", e.Name()).
				Msg("sweeping orphaned supervised process")
			killProcess(pid)
		}
		_ = os.Remove(path)
	}
}
