//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// withFakePlist points plistPath() at a temp file so tests can plant
// arbitrary content without clobbering the user's real LaunchAgent.
// HOME drives `os.UserHomeDir()` which `plistPath()` reads.
func withFakePlist(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "Library/LaunchAgents"), 0o755); err != nil {
		t.Fatal(err)
	}
	return plistPath()
}

// TestCurrentAutostartBundleID_AbsentReturnsEmpty: no plist on
// disk → "". The staleness check then treats this as "not stale"
// (autostartSelfRegister handles the first-run case via state.json).
func TestCurrentAutostartBundleID_AbsentReturnsEmpty(t *testing.T) {
	withFakePlist(t)
	if got := currentAutostartBundleID(); got != "" {
		t.Errorf("got %q, want \"\" for missing plist", got)
	}
}

// TestIsAutostartStale_AbsentReturnsFalse pins Decision #36: a
// missing plist means the user toggled "Start at login" off via
// the tray, and the launcher must NOT silently re-enable it on
// next start. Before this guard the staleness-repair branch in
// autostartSelfRegister rewrote the plist on every launcher start
// because "" != launcherBundleID, wiping the user's preference.
// Mirrors autostart_windows.go's `registered != ""` check.
func TestIsAutostartStale_AbsentReturnsFalse(t *testing.T) {
	withFakePlist(t)
	if isAutostartStale() {
		t.Error("isAutostartStale() = true with no plist on disk, want false (user-disabled autostart must stay disabled)")
	}
}

// TestCurrentAutostartBundleID_MalformedXMLReturnsEmpty: pre-flight
// migration safety — a hand-edited or corrupted plist must not
// crash the launcher. plist.Unmarshal failures collapse to "" so
// the staleness path rewrites cleanly.
func TestCurrentAutostartBundleID_MalformedXMLReturnsEmpty(t *testing.T) {
	path := withFakePlist(t)
	if err := os.WriteFile(path, []byte("not actual XML"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != "" {
		t.Errorf("got %q, want \"\" for malformed XML", got)
	}
}

// TestCurrentAutostartBundleID_V008FormatReturnsEmpty: the v0.0.8
// plist had `[<exe-path>, "--no-browser"]`. Decision #29's bundle-
// ID format is `["/usr/bin/open", "-b", "<bundle-id>", ...]`. The
// parser must reject the v0.0.8 shape so the staleness check
// returns true and the plist gets rewritten on first v0.0.9 boot.
// THIS IS THE LOAD-BEARING PATH FOR THE v0.0.8 → v0.0.9 MIGRATION.
func TestCurrentAutostartBundleID_V008FormatReturnsEmpty(t *testing.T) {
	path := withFakePlist(t)
	v008Plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/friday-launcher</string>
    <string>--no-browser</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(v008Plist), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != "" {
		t.Errorf("got %q, want \"\" for v0.0.8-format plist (must be marked stale)", got)
	}
}

// TestCurrentAutostartBundleID_CurrentFormatReturnsBundleID: the
// happy path — a Stack 3 plist returns its bundle ID. Pinned
// against the canonical launcherBundleID const so a future ID
// rename forces a deliberate test update.
func TestCurrentAutostartBundleID_CurrentFormatReturnsBundleID(t *testing.T) {
	path := withFakePlist(t)
	currentPlist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
    <string>` + launcherBundleID + `</string>
    <string>--args</string>
    <string>--no-browser</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(currentPlist), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != launcherBundleID {
		t.Errorf("got %q, want %q", got, launcherBundleID)
	}
}

// TestCurrentAutostartBundleID_DifferentBundleIDReturnsThatID:
// future-proofs against a launcherBundleID rename — the parser
// returns whatever bundle ID is registered, even if it doesn't
// match the current const. isAutostartStale() then compares
// against launcherBundleID and decides to rewrite. Pinning this
// catches a parser regression that hardcoded the expected ID.
func TestCurrentAutostartBundleID_DifferentBundleIDReturnsThatID(t *testing.T) {
	path := withFakePlist(t)
	otherPlist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
    <string>com.example.somethingelse</string>
  </array>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(otherPlist), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != "com.example.somethingelse" {
		t.Errorf("got %q, want %q", got, "com.example.somethingelse")
	}
	// And isAutostartStale should fire — the registered ID
	// differs from launcherBundleID.
	if !isAutostartStale() {
		t.Error("isAutostartStale = false, want true (bundle ID mismatch)")
	}
}

// TestCurrentAutostartBundleID_TooFewArgsReturnsEmpty: the parser
// guards `len(args) < 3` — a 2-element array has no bundle-ID
// slot, return empty. Catches a regression that swapped < for <=.
func TestCurrentAutostartBundleID_TooFewArgsReturnsEmpty(t *testing.T) {
	path := withFakePlist(t)
	shortPlist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
  </array>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(shortPlist), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != "" {
		t.Errorf("got %q, want \"\" for ProgramArguments len < 3", got)
	}
}

// TestCurrentAutostartBundleID_WrongPrefixReturnsEmpty: a plist
// with the right shape but a different invocation (not
// `/usr/bin/open -b`) is treated as v0.0.8-format-equivalent —
// rewrite. Catches a regression that just checked args[2] without
// validating the leading verb.
func TestCurrentAutostartBundleID_WrongPrefixReturnsEmpty(t *testing.T) {
	path := withFakePlist(t)
	wrongPrefix := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hellofriday.studio</string>
  <key>ProgramArguments</key>
  <array>
    <string>/some/other/binary</string>
    <string>-x</string>
    <string>` + launcherBundleID + `</string>
  </array>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(wrongPrefix), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != "" {
		t.Errorf("got %q, want \"\" for non-/usr/bin/open prefix", got)
	}
}
