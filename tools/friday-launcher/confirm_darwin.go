//go:build darwin

package main

// confirmQuit shows the macOS Quit-confirmation dialog and returns
// true if the user clicked "Quit", false if "Cancel" (or dismissed
// via Esc).
//
// We use osascript here (via showStartupErrorDialog) — NOT cgo
// NSAlert — because the systray click handler runs on a Go
// goroutine, not the main thread, and macOS NSWindow/NSAlert APIs
// throw NSInternalInconsistencyException ("NSWindow should only be
// instantiated on the main thread!") when invoked off the main
// thread. Crash observed 2026-04-28: the launcher segfaulted on
// Quit, leaving every supervised process orphaned. osascript
// spawns AppleScript which has its own NSApp, no interaction with
// ours.
//
// Decision #2: explicit confirmation in front of the destructive
// "shut down all services" path. Cmd+Q (Decision #13) bypasses this
// — power-user signal, honor it immediately.
func confirmQuit() bool {
	const buttonQuit = "Quit"
	const buttonCancel = "Cancel"
	clicked := showStartupErrorDialog(
		"Quit Friday Studio?",
		"Friday Studio will stop all running services and shut down. "+
			"This may take up to 30 seconds.",
		[]string{buttonCancel, buttonQuit},
	)
	return clicked == buttonQuit
}
