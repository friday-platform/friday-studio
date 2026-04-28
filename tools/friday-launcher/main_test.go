package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// TestShutdownGate_OneShotUnderConcurrency verifies that
// shutdownGate runs the "winner" path exactly once even when
// invoked from N goroutines simultaneously — the load-bearing
// safety claim of Decision #33 ("single CAS gate covers all
// trigger paths").
//
// A regression that flips the CAS to a non-atomic if/then/set
// (or to two atomics that don't agree on ordering) would let
// multiple goroutines past the gate; this test catches that.
func TestShutdownGate_OneShotUnderConcurrency(t *testing.T) {
	// Reset package-globals shutdownGate touches; previous tests
	// in the same binary may have flipped them.
	t.Cleanup(func() {
		shutdownStarted.Store(false)
		shuttingDown.Store(false)
	})
	shutdownStarted.Store(false)
	shuttingDown.Store(false)

	const goroutines = 64
	var winners atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})

	for range goroutines {
		wg.Go(func() {
			<-start // unblock all goroutines simultaneously
			if shutdownGate("test:concurrent") {
				winners.Add(1)
			}
		})
	}

	close(start)
	wg.Wait()

	if got := winners.Load(); got != 1 {
		t.Errorf("shutdownGate winners = %d, want exactly 1", got)
	}
	if !shuttingDown.Load() {
		t.Errorf("shuttingDown.Load() = false, want true after gate fired")
	}
	if !shutdownStarted.Load() {
		t.Errorf("shutdownStarted.Load() = false, want true after gate fired")
	}
}

// TestShutdownGate_SecondCallReturnsFalse verifies that a single
// caller flow (gate fires once, then again) doesn't double-fire.
// Sanity check beyond the concurrency test.
func TestShutdownGate_SecondCallReturnsFalse(t *testing.T) {
	t.Cleanup(func() {
		shutdownStarted.Store(false)
		shuttingDown.Store(false)
	})
	shutdownStarted.Store(false)
	shuttingDown.Store(false)

	if !shutdownGate("test:first") {
		t.Fatal("first call should win the gate")
	}
	if shutdownGate("test:second") {
		t.Error("second call should lose the gate; got winner")
	}
}
