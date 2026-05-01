// nsapp_darwin.m — cgo Objective-C shim for the
// NSApplicationWillTerminateNotification observer.
//
// Decision #13: when NSApp terminates due to causes OUTSIDE our
// systray-Quit path (system shutdown, force-quit from Activity
// Monitor, OS-level termination), we want one last chance to call
// performShutdown so supervised processes get an orderly stop.
// The observer's selector runs synchronously on the main thread,
// blocking the NSApp event loop until performShutdown returns.
//
// On graceful Cmd+Q-style termination the observer fires AFTER
// applicationShouldTerminate: has already returned YES — we get
// the full 30s budget for supervisor.Shutdown.
//
// On system shutdown the OS gives us a much shorter window
// (typically ~10s) before SIGKILL. performShutdown's 30s
// supervisor deadline will likely be cut short and orphans will
// survive — the launcher's startup-time SweepByBinaryPath reaps
// them on next boot. Acceptable per v15 plan.

#import <Cocoa/Cocoa.h>

// Implemented in Go, exported via cgo's `//export` annotation.
// Synchronously calls performShutdown("nsapp:willTerminate").
extern void friday_nsapp_will_terminate(void);

@interface FridayNSAppObserver : NSObject
@end

@implementation FridayNSAppObserver
- (void)willTerminate:(NSNotification *)__unused notification {
    friday_nsapp_will_terminate();
}
@end

// Process-lifetime singleton — strong reference so ARC / manual-RC
// can't deallocate the observer between registration and
// notification.
static FridayNSAppObserver *gFridayObserver = nil;

// friday_nsapp_register_will_terminate is idempotent: a second
// call is a no-op so onReady can call it once and not worry about
// re-entry from any future restart-style code path.
void friday_nsapp_register_will_terminate(void) {
    @autoreleasepool {
        if (gFridayObserver != nil) return;
        gFridayObserver = [[FridayNSAppObserver alloc] init];
        [[NSNotificationCenter defaultCenter]
            addObserver:gFridayObserver
               selector:@selector(willTerminate:)
                   name:NSApplicationWillTerminateNotification
                 object:nil];
    }
}
