//go:build !darwin && !windows

package main

// confirmQuit on Linux / other-OS skips the dialog and assumes
// the user meant it. Linux integrators can re-implement via
// dbus org.freedesktop.Notifications or zenity if the audience
// ever justifies the dependency.
func confirmQuit() bool {
	return true
}
