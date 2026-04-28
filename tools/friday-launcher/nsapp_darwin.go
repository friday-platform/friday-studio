//go:build darwin

// See note on linker warning in confirm_darwin.go — same lobjc
// duplicate-libraries situation applies here.

package main

/*
#include <stdbool.h>
extern void friday_nsapp_register_will_terminate(void);
*/
import "C"

// friday_nsapp_will_terminate is the cgo callback the Objective-C
// observer's selector calls when NSApp posts
// NSApplicationWillTerminateNotification. Decision #13: synchronous
// call into performShutdown so the NSApp event loop blocks until
// teardown is done (or the OS hard-kills us — accepted failure
// mode).
//
// The //export comment tells cgo to emit a C-callable wrapper
// matching the `extern void friday_nsapp_will_terminate(void)`
// declaration in nsapp_darwin.m.
//
//export friday_nsapp_will_terminate
func friday_nsapp_will_terminate() {
	performShutdown("nsapp:willTerminate")
}

// nsappWillTerminateAnchor keeps friday_nsapp_will_terminate
// reachable to `deadcode -test`. The actual call site is the
// Objective-C observer's selector at notification time; deadcode's
// pure-Go reachability analysis can't trace that edge. Assigning
// the function value to a package-level (non-blank) variable that
// is read in registerNSAppWillTerminate is enough for the analyzer
// to consider the function used. Zero runtime cost — the read just
// dereferences a function pointer.
var nsappWillTerminateAnchor = friday_nsapp_will_terminate

// registerNSAppWillTerminate plumbs the Objective-C observer into
// NSNotificationCenter.defaultCenter once. Must be called from
// onReady (or anywhere AFTER systray.Run has booted NSApp) — the
// observer needs an NSApp to listen to. Idempotent: a second call
// is a no-op on the C side.
func registerNSAppWillTerminate() {
	_ = nsappWillTerminateAnchor // see comment above; reachability anchor.
	C.friday_nsapp_register_will_terminate()
}
