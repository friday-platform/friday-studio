// confirm_darwin.m — cgo Objective-C shim for the Quit confirmation
// dialog. Called from confirmQuit() in confirm_darwin.go (which is
// invoked from the systray Quit menu-item click handler).
//
// Why NSAlert here (and not osascript): by the time the user clicks
// the tray's Quit menu item, NSApp is up — systray.Run has been
// running. NSAlert.runModal needs an NSApp; native dialog gives us
// nicer styling than osascript would. Pre-flight + bind-failure run
// BEFORE systray.Run and use osascript instead (see
// preflight_dialog_darwin.go).

#import <Cocoa/Cocoa.h>
#include <stdbool.h>

// friday_confirm_quit shows a modal NSAlert with two buttons (Quit /
// Cancel) and returns true iff the user clicked Quit. Synchronous —
// the systray click handler runs on the main thread, so blocking
// here is fine.
//
// Default button is the first one added ("Quit") — clicking through
// with Enter shuts down. macOS convention is "destructive default
// is OK if it's framed as a confirmation"; the tray's Quit menu
// item is itself an explicit user action, so re-confirming with
// Enter is the path of least friction.
bool friday_confirm_quit(void) {
    @autoreleasepool {
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Quit Friday Studio?"];
        [alert setInformativeText:
            @"Friday Studio will stop all running services and "
             "shut down. This may take up to 30 seconds."];
        [alert setAlertStyle:NSAlertStyleWarning];
        [alert addButtonWithTitle:@"Quit"];
        [alert addButtonWithTitle:@"Cancel"];

        NSModalResponse response = [alert runModal];
        return response == NSAlertFirstButtonReturn;
    }
}
