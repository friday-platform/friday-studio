//go:build !darwin

package main

// appBundlePath is a darwin-only concept (Friday Studio.app at
// /Applications). On Linux + Windows the launcher binary doesn't
// live inside a directory bundle that --uninstall should remove;
// the empty return signals "no .app bundle to clean up" to
// removeAppBundleIfPresent.
func appBundlePath() string {
	return ""
}
