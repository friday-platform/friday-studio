//go:build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"howett.net/plist"
)

// plistTemplate has three %s slots: Label, executable path, first arg.
// KeepAlive=false because the launcher's process-compose handles
// child restart internally; we only want launchd to (re-)launch us
// at login. RunAtLoad=true triggers that.
const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>%s</string>
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
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	body := fmt.Sprintf(plistTemplate, launchAgentLabel, exe, "--no-browser")
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

// currentAutostartPath returns the executable path currently registered
// in the LaunchAgent plist, or "" if no plist exists / unreadable.
// Used by goroutine E to detect staleness when the user has moved
// the launcher binary to a new location.
func currentAutostartPath() string {
	data, err := os.ReadFile(plistPath())
	if err != nil {
		return ""
	}
	var agent launchAgent
	if _, err := plist.Unmarshal(data, &agent); err != nil {
		return ""
	}
	if len(agent.ProgramArguments) == 0 {
		return ""
	}
	return agent.ProgramArguments[0]
}
