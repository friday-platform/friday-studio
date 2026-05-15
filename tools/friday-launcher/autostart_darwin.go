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
// RunAtLoad=true triggers (re-)launch at login.
//
// KeepAlive={Crashed: true} narrows launchd's restart trigger to
// "the process exited abnormally" — non-zero exit code or terminated
// by an uncaught signal. Two paths benefit:
//
//   - launcher panics / segfaults / OOMs → launchd brings it back
//     within seconds, so a transient bug doesn't leave the user
//     staring at a dead tray icon until next login. Without this,
//     `KeepAlive=false` meant any crash stayed crashed.
//   - process-compose's runner fails fatally and the launcher's
//     watchdog can't recover → same recovery path.
//
// Deliberate non-triggers (i.e. when launchd MUST NOT restart):
//
//   - User clicks "Quit" in the tray menu → performShutdown runs,
//     main() returns 0, launchd sees clean exit, leaves it stopped.
//   - User toggles "Start at login" off → plistPath() is removed
//     entirely (`disableAutostart`), so KeepAlive doesn't matter.
//   - Installer's `terminate_studio_processes` SIGTERM → launcher's
//     signal handler runs performShutdown and exits 0. Same clean
//     exit, so launchd doesn't fight the installer's deliberate
//     downtime window. (The installer-cancel trap is a separate
//     issue tracked elsewhere.)
//
// Apple docs: <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html#//apple_ref/doc/uid/10000172i-SW7>
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
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
</dict>
</plist>`

// launchAgent mirrors the subset of the plist we read back. KeepAlive
// is `any` because the schema is a discriminated union — `<false/>`
// (the v0.0.x shape) parses to `bool`, the new `<dict><key>Crashed</key>
// <true/></dict>` parses to `map[string]any`. Pinning the field to
// `bool` made the new shape unmarshal-fail silently, which would mean
// every staleness check returned "not stale" for installs that
// already have the dict form — defeating the migration check below.
type launchAgent struct {
	Label            string   `plist:"Label"`
	ProgramArguments []string `plist:"ProgramArguments"`
	RunAtLoad        bool     `plist:"RunAtLoad"`
	KeepAlive        any      `plist:"KeepAlive"`
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
	agent, ok := readLaunchAgent()
	if !ok {
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

// readLaunchAgent reads + unmarshals the plist into a launchAgent
// once, so both bundle-ID extraction and KeepAlive-shape checks share
// one file read. Returns (zero, false) for any failure — missing
// file, IO error, malformed XML.
func readLaunchAgent() (launchAgent, bool) {
	data, err := os.ReadFile(plistPath())
	if err != nil {
		return launchAgent{}, false
	}
	var agent launchAgent
	if _, err := plist.Unmarshal(data, &agent); err != nil {
		return launchAgent{}, false
	}
	return agent, true
}

// hasCrashOnlyKeepAlive reports whether the parsed plist's KeepAlive
// value is exactly `{Crashed: true}` — the shape this launcher now
// writes. The historical shape (`<false/>` → `bool(false)`) and any
// other dict shape both return false, marking the plist for rewrite.
// Strict-equality check (single key, value true) so a future plist
// that adds more KeepAlive sub-keys for a new feature is correctly
// detected as different + rewritten.
func hasCrashOnlyKeepAlive(agent launchAgent) bool {
	m, ok := agent.KeepAlive.(map[string]any)
	if !ok {
		return false
	}
	if len(m) != 1 {
		return false
	}
	crashed, ok := m["Crashed"].(bool)
	return ok && crashed
}

// isAutostartStale reports whether the LaunchAgent plist needs to
// be rewritten. Cross-platform contract — see autostart_linux.go +
// autostart_windows.go for the per-OS interpretation.
//
// Darwin: stale iff a plist is present AND any of:
//   - registered bundle ID differs from launcherBundleID (covers
//     v0.0.8-format plists with a raw exe path, and future bundle-ID
//     renames);
//   - KeepAlive is anything other than `{Crashed: true}` (covers
//     v0.0.x-format plists that used `<false/>`, so the
//     crash-recovery upgrade rolls out automatically on next launcher
//     boot).
//
// An absent plist is NOT stale — it means the user toggled "Start at
// login" off via the tray, and Decision #36 says a deliberately-
// disabled autostart stays disabled. Without that guard, the
// autostartSelfRegister staleness-repair pass would silently
// re-enable autostart on every launcher start, ignoring the user's
// preference. Mirrors autostart_windows.go's "is the file there at
// all" check.
func isAutostartStale() bool {
	agent, ok := readLaunchAgent()
	if !ok {
		return false
	}
	registered := currentAutostartBundleID()
	if registered == "" || registered != launcherBundleID {
		return true
	}
	return !hasCrashOnlyKeepAlive(agent)
}
