//go:build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"howett.net/plist"
)

// plistTemplate has one %s slot: the bundle ID. ProgramArguments
// is `/usr/bin/open -b <bundle-id> --args --no-browser`, which
// dispatches via LaunchServices to whichever Friday Studio.app is
// currently registered (Decision #29). Targeting the bundle ID
// rather than a raw executable path means the plist doesn't go
// stale if the user moves Friday Studio.app to a new location —
// LaunchServices indexes /Applications and finds it.
//
// `--args --no-browser` propagates the headless-launch flag to the
// launcher binary inside the bundle. `open`'s --args separator
// switches `open` from "treat remaining tokens as document paths"
// to "pass them as argv to the bundled executable."
//
// KeepAlive=false because process-compose handles child restart
// internally; we only want launchd to (re-)launch us at login.
// RunAtLoad=true triggers that.
const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
    <string>%s</string>
    <string>--args</string>
    <string>--no-browser</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>`

type launchAgent struct {
	Label            string   `plist:"Label"`
	ProgramArguments []string `plist:"ProgramArguments"`
	RunAtLoad        bool     `plist:"RunAtLoad"`
	KeepAlive        bool     `plist:"KeepAlive"`
}

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home,
		"Library/LaunchAgents", launchAgentLabel+".plist")
}

func enableAutostart() error {
	body := fmt.Sprintf(plistTemplate, launchAgentLabel, launcherBundleID)
	return atomicWriteFile(plistPath(), []byte(body), 0o644)
}

func disableAutostart() error {
	err := os.Remove(plistPath())
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func isAutostartEnabled() bool {
	_, err := os.Stat(plistPath())
	return err == nil
}

// currentAutostartBundleID returns the bundle ID currently
// registered in the LaunchAgent plist, or "" if the plist is
// missing / unreadable / not in the bundle-ID format. Stack 3
// switched ProgramArguments from `[<exe-path>, "--no-browser"]`
// to `["/usr/bin/open", "-b", <bundle-id>, "--args", "--no-browser"]`,
// so staleness is now "different bundle ID" not "different exe
// path." A v0.0.8-format plist (where ProgramArguments[0] is the
// raw exe path) returns "" so the migration code knows to rewrite.
func currentAutostartBundleID() string {
	data, err := os.ReadFile(plistPath())
	if err != nil {
		return ""
	}
	var agent launchAgent
	if _, err := plist.Unmarshal(data, &agent); err != nil {
		return ""
	}
	args := agent.ProgramArguments
	// Expected shape: ["/usr/bin/open", "-b", "<bundle-id>", ...]
	if len(args) < 3 {
		return ""
	}
	if args[0] != "/usr/bin/open" || args[1] != "-b" {
		return ""
	}
	return args[2]
}

// isAutostartStale reports whether the LaunchAgent plist needs to
// be rewritten. Cross-platform contract — see autostart_linux.go +
// autostart_windows.go for the per-OS interpretation.
//
// Darwin: stale iff the registered bundle ID differs from
// launcherBundleID (covers both the v0.0.8-format plist and a
// future bundle-ID rename).
func isAutostartStale() bool {
	registered := currentAutostartBundleID()
	return registered != launcherBundleID
}
