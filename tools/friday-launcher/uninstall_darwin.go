//go:build darwin

package main

// appBundlePath returns the canonical Friday Studio.app location on
// macOS — `/Applications/Friday Studio.app`. Stack 3's installer
// commits to one canonical location (no `~/Applications` fallback
// per the v15 plan, §Issue 5 step 4); --uninstall removes exactly
// this path.
//
// The path is hardcoded rather than derived from os.Executable()
// because the launcher might be running from a different location
// (dev build, side-load test) where rm-rf'ing the parent .app
// would either be wrong (dev build inside repo) or destructive
// (typo-prone exe path traversal). Hardcoding closes both holes.
func appBundlePath() string {
	return "/Applications/Friday Studio.app"
}
