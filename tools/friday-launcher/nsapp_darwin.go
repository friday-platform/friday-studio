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
// declaration in nsapp_darwin.m. The blank-identifier reference
// below keeps `deadcode -test` happy — the actual call site is in
// the Objective-C observer's selector, which deadcode's pure-Go
// reachability analysis can't trace.
//
//export friday_nsapp_will_terminate
func friday_nsapp_will_terminate() {
	performShutdown("nsapp:willTerminate")
}

// registerNSAppWillTerminate plumbs the Objective-C observer into
// NSNotificationCenter.defaultCenter once. Must be called from
// onReady (or anywhere AFTER systray.Run has booted NSApp) — the
// observer needs an NSApp to listen to. Idempotent: a second call
// is a no-op on the C side.
func registerNSAppWillTerminate() {
	// Dead at runtime, reachable to deadcode's static analysis.
	// cgo //export dispatches friday_nsapp_will_terminate via the
	// Objective-C observer's selector at notification time;
	// deadcode's pure-Go reachability analysis can't trace that
	// edge, so without this anchor it reports the function as
	// unreachable and the CI deadcode job fails.
	if neverTrue() {
		friday_nsapp_will_terminate()
	}
	C.friday_nsapp_register_will_terminate()
}

// neverTrue returns false. Used by registerNSAppWillTerminate as a
// reachability anchor for cgo-exported callbacks. Defined as a
// non-inline function so the Go compiler doesn't optimize the
// caller's `if neverTrue()` branch away before deadcode runs its
// source-level analysis.
//
//go:noinline
func neverTrue() bool { return false }
