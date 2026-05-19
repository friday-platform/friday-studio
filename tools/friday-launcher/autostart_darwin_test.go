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
	stale, reason := isAutostartStale()
	if stale {
		t.Errorf("isAutostartStale() = (true, %q) with no plist on disk, want (false, \"\") (user-disabled autostart must stay disabled)", reason)
	}
	if reason != "" {
		t.Errorf("isAutostartStale() reason = %q, want \"\" when not stale", reason)
	}
}

// TestIsAutostartStale_MalformedXMLReturnsFalse pins the second
// Decision #36 path: an unreadable/hand-edited plist must NOT be
// silently rewritten — we don't know what the user wanted. The
// new isAutostartStale early-returns false when readLaunchAgent
// fails. A future refactor that flipped this to "treat unreadable
// as stale, just rewrite" would slip past every other test in
// this file; this assertion stops that.
func TestIsAutostartStale_MalformedXMLReturnsFalse(t *testing.T) {
	path := withFakePlist(t)
	if err := os.WriteFile(path, []byte("not actual XML"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale, reason := isAutostartStale()
	if stale {
		t.Errorf("isAutostartStale() = (true, %q) for malformed XML, want (false, \"\")", reason)
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
// happy path — a current plist (with the crash-recovery KeepAlive
// dict from the v0.0.10+ upgrade) returns its bundle ID. Pinned
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
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
</dict>
</plist>`
	if err := os.WriteFile(path, []byte(currentPlist), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := currentAutostartBundleID(); got != launcherBundleID {
		t.Errorf("got %q, want %q", got, launcherBundleID)
	}
	// Sister assertion: a canonically-shaped plist must NOT be marked
	// stale. Without this, the staleness-repair pass would rewrite the
	// plist on every launcher start — chewing through file I/O for no
	// reason AND breaking any "the plist was rewritten" signal that
	// telemetry might want to attach in future.
	if stale, reason := isAutostartStale(); stale {
		t.Errorf("isAutostartStale() = (true, %q) on canonically-shaped plist, want (false, \"\")", reason)
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
	stale, reason := isAutostartStale()
	if !stale {
		t.Error("isAutostartStale = false, want true (bundle ID mismatch)")
	}
	if reason != "bundle_id_mismatch" {
		t.Errorf("isAutostartStale reason = %q, want %q", reason, "bundle_id_mismatch")
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

// TestHasCrashOnlyKeepAlive_BoolFalse: the historical v0.0.x plist
// shape (`<key>KeepAlive</key><false/>`) parses to `bool(false)`,
// which must be rejected by hasCrashOnlyKeepAlive so the staleness
// pass rewrites it with the dict form. THIS IS THE LOAD-BEARING PATH
// FOR THE v0.0.x → crash-recovery KeepAlive MIGRATION — without it,
// users who deployed before the upgrade would never get the new
// shape and crashed launchers would stay dead.
func TestHasCrashOnlyKeepAlive_BoolFalse(t *testing.T) {
	if hasCrashOnlyKeepAlive(launchAgent{KeepAlive: false}) {
		t.Error("hasCrashOnlyKeepAlive(bool false) = true, want false")
	}
}

// TestHasCrashOnlyKeepAlive_BoolTrue: defensively rejects the
// `<key>KeepAlive</key><true/>` shape too. Friday has never written
// that, but a hand-edited or future-altered plist mustn't sneak past
// the staleness check just because the value is "truthy."
func TestHasCrashOnlyKeepAlive_BoolTrue(t *testing.T) {
	if hasCrashOnlyKeepAlive(launchAgent{KeepAlive: true}) {
		t.Error("hasCrashOnlyKeepAlive(bool true) = true, want false")
	}
}

// TestHasCrashOnlyKeepAlive_DictWithCrashedTrue: the canonical shape
// we write today. This is the only input that should return true.
func TestHasCrashOnlyKeepAlive_DictWithCrashedTrue(t *testing.T) {
	agent := launchAgent{KeepAlive: map[string]any{"Crashed": true}}
	if !hasCrashOnlyKeepAlive(agent) {
		t.Error("hasCrashOnlyKeepAlive({Crashed: true}) = false, want true")
	}
}

// TestHasCrashOnlyKeepAlive_DictWithCrashedFalse: a dict with the
// right key but the wrong value — `{Crashed: false}` would tell
// launchd to restart on CLEAN exit instead of crash, the opposite of
// what we want. Must be rejected so the rewrite path replaces it.
func TestHasCrashOnlyKeepAlive_DictWithCrashedFalse(t *testing.T) {
	agent := launchAgent{KeepAlive: map[string]any{"Crashed": false}}
	if hasCrashOnlyKeepAlive(agent) {
		t.Error("hasCrashOnlyKeepAlive({Crashed: false}) = true, want false")
	}
}

// TestHasCrashOnlyKeepAlive_DictWithExtraKey: a dict that has
// {Crashed: true} but also a second sub-key (NetworkState,
// SuccessfulExit, AfterInitialDemand, etc.) is not our canonical
// shape. Strict-equality match: extra keys → stale, because future
// versions of this launcher may add a key for a new feature and the
// staleness check needs to fire so the upgrade rolls out.
func TestHasCrashOnlyKeepAlive_DictWithExtraKey(t *testing.T) {
	agent := launchAgent{KeepAlive: map[string]any{
		"Crashed":        true,
		"SuccessfulExit": false,
	}}
	if hasCrashOnlyKeepAlive(agent) {
		t.Error("hasCrashOnlyKeepAlive({Crashed:true, SuccessfulExit:false}) = true, want false")
	}
}

// TestHasCrashOnlyKeepAlive_EmptyDict: a plist with `<key>KeepAlive
// </key><dict></dict>` is technically valid launchd syntax (means
// "always keep alive") — definitely not our crash-only shape. Reject.
func TestHasCrashOnlyKeepAlive_EmptyDict(t *testing.T) {
	if hasCrashOnlyKeepAlive(launchAgent{KeepAlive: map[string]any{}}) {
		t.Error("hasCrashOnlyKeepAlive(empty dict) = true, want false")
	}
}

// TestHasCrashOnlyKeepAlive_AbsentField: a plist with no KeepAlive
// key at all (default: never restart) parses to a nil any. Reject —
// even though the behaviour is "no restart on anything," it's not
// the shape we now own, and we want the upgrade to install our
// explicit `{Crashed: true}` dict.
func TestHasCrashOnlyKeepAlive_AbsentField(t *testing.T) {
	if hasCrashOnlyKeepAlive(launchAgent{KeepAlive: nil}) {
		t.Error("hasCrashOnlyKeepAlive(nil) = true, want false")
	}
}

// TestIsAutostartStale_OldKeepAliveShapeIsStale: the migration
// trigger — an installed plist that has the correct bundle ID but
// the old `<key>KeepAlive</key><false/>` shape must be marked stale
// so the next launcher boot rewrites it with the new dict. Without
// this assertion, the v0.0.x → crash-recovery rollout would silently
// no-op on every existing user's machine.
func TestIsAutostartStale_OldKeepAliveShapeIsStale(t *testing.T) {
	path := withFakePlist(t)
	oldShape := `<?xml version="1.0" encoding="UTF-8"?>
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
	if err := os.WriteFile(path, []byte(oldShape), 0o600); err != nil {
		t.Fatal(err)
	}
	stale, reason := isAutostartStale()
	if !stale {
		t.Error("isAutostartStale() = false for old KeepAlive shape, want true (migration must fire)")
	}
	if reason != "keepalive_shape" {
		t.Errorf("isAutostartStale() reason = %q, want %q", reason, "keepalive_shape")
	}
}

// TestIsAutostartStale_V008ShapeIsStale: a v0.0.8 plist (raw exe
// path, no `/usr/bin/open -b` wrapper) has neither the right bundle
// ID format NOR the new KeepAlive shape — must be stale. Codifies a
// claim that was previously aspirational in the file's comments but
// not actually asserted: the old isAutostartStale `registered != ""`
// guard meant v0.0.8 plists were silently treated as "not stale."
// The fix is implicit in the refactored isAutostartStale; this test
// pins it down.
func TestIsAutostartStale_V008ShapeIsStale(t *testing.T) {
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
	stale, reason := isAutostartStale()
	if !stale {
		t.Error("isAutostartStale() = false for v0.0.8 plist, want true (migration must fire)")
	}
	// v0.0.8 plists fail the bundle-ID check first (raw exe path,
	// no /usr/bin/open -b wrapper), so the reason is bundle_id_mismatch
	// rather than keepalive_shape — even though the KeepAlive=<false/>
	// would ALSO trip the shape check if we got that far.
	if reason != "bundle_id_mismatch" {
		t.Errorf("isAutostartStale() reason = %q, want %q", reason, "bundle_id_mismatch")
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

// TestEnableAutostartProducesNonStalePlist pins the load-bearing
// round-trip invariant: whatever plistTemplate writes today must be
// accepted as canonical by isAutostartStale on read-back. If a future
// edit changes the template (or hasCrashOnlyKeepAlive) in a way that
// breaks this round-trip, every launcher boot would mark its own
// freshly-written plist as stale, rewrite it, mark it stale on the
// next boot, ad infinitum. Every other test in this file uses
// hand-rolled XML strings; this is the only one that exercises the
// real template through the real read-back path.
func TestEnableAutostartProducesNonStalePlist(t *testing.T) {
	withFakePlist(t)
	if err := enableAutostart(); err != nil {
		t.Fatalf("enableAutostart() error = %v", err)
	}
	stale, reason := isAutostartStale()
	if stale {
		t.Errorf("freshly-written plist is stale: reason=%q. Either plistTemplate drifted from hasCrashOnlyKeepAlive(), or the bundle-ID match broke — fix one to match the other.", reason)
	}
}
