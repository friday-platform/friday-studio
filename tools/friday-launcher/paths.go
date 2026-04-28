package main

import (
	"os"
	"path/filepath"
)

const launchAgentLabel = "ai.hellofriday.studio"

func friendlyHome() string {
	if v := os.Getenv("FRIDAY_LAUNCHER_HOME"); v != "" {
		return v
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".friday", "local")
	}
	return filepath.Join(os.TempDir(), ".friday", "local")
}

func pidsDir() string   { return filepath.Join(friendlyHome(), "pids") }
func logsDir() string   { return filepath.Join(friendlyHome(), "logs") }
func statePath() string { return filepath.Join(friendlyHome(), "state.json") }

func launcherPidPath() string { return filepath.Join(pidsDir(), "launcher.pid") }
func launcherLogPath() string { return filepath.Join(logsDir(), "launcher.log") }
func processLogPath(name string) string {
	return filepath.Join(logsDir(), name+".log")
}

func ensureDirs() error {
	for _, d := range []string{friendlyHome(), pidsDir(), logsDir()} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			return err
		}
	}
	return nil
}
