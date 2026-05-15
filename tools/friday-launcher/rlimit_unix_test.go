//go:build !windows

package main

import (
	"syscall"
	"testing"
)

// TestRaiseFileLimit_BumpsSoftToward64K asserts the post-call soft
// limit is at least the prior soft limit, and — when the hard limit
// allows it — reaches targetFileLimit. The "at least" guard is what
// load-bears the incident fix: the launcher must never leave the
// process with a lower cap than the caller's shell already had.
//
// The test runs in-process (setrlimit mutates the test binary's own
// rlimit, not the launcher process's). Cleanup restores the prior
// limits so later tests in the same binary aren't subject to the
// bumped cap — important because go test runs the whole package's
// tests in one process.
func TestRaiseFileLimit_BumpsSoftToward64K(t *testing.T) {
	var before syscall.Rlimit
	if err := syscall.Getrlimit(
		syscall.RLIMIT_NOFILE, &before); err != nil {
		t.Fatalf("getrlimit before: %v", err)
	}
	t.Cleanup(func() {
		_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &before)
	})

	raiseFileLimit()

	var after syscall.Rlimit
	if err := syscall.Getrlimit(
		syscall.RLIMIT_NOFILE, &after); err != nil {
		t.Fatalf("getrlimit after: %v", err)
	}

	if after.Cur < before.Cur {
		t.Fatalf("soft cap regressed: before=%d after=%d",
			before.Cur, after.Cur)
	}
	// On CI hosts where the test binary already inherits a soft cap
	// >= targetFileLimit, raiseFileLimit logs "already adequate" and
	// is a no-op. Otherwise the post-call soft should reach the
	// target (modern macOS / Linux) or the fallback (the rare older
	// macOS path) — anything less means the retry tier silently
	// gave up.
	if before.Cur < targetFileLimit {
		if after.Cur != targetFileLimit &&
			after.Cur != fallbackFileLimit {
			t.Fatalf("soft cap landed at unexpected value: "+
				"before=%d after=%d target=%d fallback=%d",
				before.Cur, after.Cur,
				targetFileLimit, fallbackFileLimit)
		}
	}
}

// TestRaiseFileLimit_NoOpWhenAlreadyHigh verifies raiseFileLimit
// leaves the rlimit alone when the caller already has a soft cap
// >= targetFileLimit. Catches a regression where the function
// blindly calls setrlimit and accidentally LOWERS the cap (e.g. if
// a future refactor forgets the early-return on rl.Cur >= target).
func TestRaiseFileLimit_NoOpWhenAlreadyHigh(t *testing.T) {
	var before syscall.Rlimit
	if err := syscall.Getrlimit(
		syscall.RLIMIT_NOFILE, &before); err != nil {
		t.Fatalf("getrlimit before: %v", err)
	}
	t.Cleanup(func() {
		_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &before)
	})

	// Pre-raise to target so the function should be a no-op. Skip
	// if the host won't even let us reach the target — there's
	// nothing meaningful to assert against in that case.
	primed := before
	primed.Cur = targetFileLimit
	if before.Max != 0 && primed.Cur > before.Max {
		primed.Cur = before.Max
	}
	if err := syscall.Setrlimit(
		syscall.RLIMIT_NOFILE, &primed); err != nil {
		t.Skipf("host rejects setrlimit at target tier (%d), "+
			"can't exercise the no-op path: %v",
			primed.Cur, err)
	}

	raiseFileLimit()

	var after syscall.Rlimit
	if err := syscall.Getrlimit(
		syscall.RLIMIT_NOFILE, &after); err != nil {
		t.Fatalf("getrlimit after: %v", err)
	}
	if after.Cur != primed.Cur {
		t.Fatalf("soft cap changed unexpectedly: "+
			"primed=%d after=%d", primed.Cur, after.Cur)
	}
}
