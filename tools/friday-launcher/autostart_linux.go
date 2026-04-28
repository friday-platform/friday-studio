//go:build linux

package main

// Autostart on Linux is not implemented. The launcher targets macOS and
// Windows for desktop launch-at-login (via launchd and the Startup folder
// respectively). Linux desktop autostart varies wildly by environment
// (XDG autostart, systemd --user, KDE/GNOME-specific config) and isn't
// shipped today. These no-op stubs satisfy the cross-platform call sites
// so the package builds on Linux for CI lint/test.
//
// We also reference launchAgentLabel from paths.go so the lint's
// `unusedfunc` check stays happy across all targets — Linux doesn't
// otherwise touch it.

var (
	_ = launchAgentLabel
	_ = launcherBundleID
)

func enableAutostart() error   { return nil }
func disableAutostart() error  { return nil }
func isAutostartEnabled() bool { return false }
func isAutostartStale() bool   { return false }
