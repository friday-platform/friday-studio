package main

import (
	"os"
	"path/filepath"
)

// launchAgentLabel is the LaunchAgent plist's `Label` field (Decision
// #14). Pinned across versions so v0.0.8 → v0.0.9 migration doesn't
// have to delete a prior plist with a different label.
const launchAgentLabel = "ai.hellofriday.studio"

// launcherBundleID is the .app's CFBundleIdentifier (Decision #3).
// Stack 3's autostart plist invokes `open -b <bundleID>` so reboot
// targets the bundled .app via LaunchServices rather than a raw exe
// path that would go stale if the user moves the .app. NOT the same
// as launchAgentLabel — Apple recommends distinct values to avoid
// LaunchServices treating the LaunchAgent as the .app's daemon.
const launcherBundleID = "ai.hellofriday.studio-launcher"

// bundledAgentSDKVersion pins the friday-agent-sdk PyPI version that
// the daemon spawns user agents against (apps/atlasd/src/agent-spawn.ts
// reads this via FRIDAY_AGENT_SDK_VERSION). Bumping is a deliberate
// launcher-release coordinated bump: we test this launcher's daemon
// against the SDK version named here. PyPI:
// https://pypi.org/project/friday-agent-sdk/
const bundledAgentSDKVersion = "0.1.2"

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
