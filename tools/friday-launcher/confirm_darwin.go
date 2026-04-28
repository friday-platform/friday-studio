//go:build darwin

// Note on linker warning: this file produces an
// "ld: warning: ignoring duplicate libraries: '-lobjc'" at build
// time on macOS. The duplicate comes from fyne.io/systray's darwin
// backend already linking objc and Apple's clang implicitly adding
// -lobjc again when compiling our .m file. Go's cgo whitelist
// rejects -Wl,-no_warn_duplicate_libraries, and -lobjc is added
// implicitly by clang either way — there's no portable way to
// suppress the warning. The build still succeeds; the warning is
// cosmetic and only seen during local macOS dev (CI builds on
// Linux don't see it).

package main

/*
#include <stdbool.h>
extern bool friday_confirm_quit(void);
*/
import "C"

// confirmQuit shows the macOS Quit-confirmation NSAlert and returns
// true if the user clicked "Quit", false if "Cancel". MUST be
// called from the main thread (the systray click handler runs there
// on macOS — NSAlert.runModal blocks on the NSApp event loop).
//
// Decision #2: an explicit confirmation in front of the destructive
// "shut down all services" path. Cmd+Q (Decision #13) bypasses this
// — power-user signal, honor it immediately.
func confirmQuit() bool {
	return bool(C.friday_confirm_quit())
}
