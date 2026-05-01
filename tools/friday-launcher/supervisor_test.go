package main

import (
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/f1bonacc1/process-compose/src/types"
)

// fakeRunner records every method call so tests can pin RestartAll's
// behavior without spinning up real subprocesses. Run() blocks on a
// channel until ShutDownProject closes it, mirroring the contract of
// *app.ProjectRunner — Run is supposed to block for the lifetime of
// the supervisor.
type fakeRunner struct {
	mu             sync.Mutex
	restartCalls   []string // ordered list of RestartProcess(name) args
	runStarted     atomic.Bool
	runReturned    atomic.Bool
	runDone        chan struct{}
	restartProcErr error // optional error to return from RestartProcess
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{runDone: make(chan struct{})}
}

func (f *fakeRunner) Run() error {
	f.runStarted.Store(true)
	<-f.runDone
	f.runReturned.Store(true)
	return nil
}

func (f *fakeRunner) RestartProcess(name string) error {
	f.mu.Lock()
	f.restartCalls = append(f.restartCalls, name)
	err := f.restartProcErr
	f.mu.Unlock()
	return err
}

func (f *fakeRunner) ShutDownProject() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.runDone:
		// Already closed — defensive against double-shutdown.
	default:
		close(f.runDone)
	}
	return nil
}

func (f *fakeRunner) GetProcessesState() (*types.ProcessesState, error) {
	return &types.ProcessesState{}, nil
}

func (f *fakeRunner) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.restartCalls...)
}

// waitFor polls cond every 10ms up to timeout. Used to wait on
// goroutine progress without sleeping unconditionally.
func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

// TestSupervisorRestartAllUsesRestartProcess pins the Bug 3 fix:
// RestartAll calls processRunner.RestartProcess for every supervised
// service in startOrder. The old shape (StopProcess + StartProcess
// in two passes) caused process-compose's Run() loop to exit with
// "Project completed" between the last stop and the first start —
// SupervisorExited latched true and the tray painted red forever
// even though children came right back up.
//
// Per-service RestartProcess keeps process-compose's restartCalls
// map non-empty for the duration of each call, so its Run() loop's
// project-completed branch is gated and Run stays in its loop.
//
// Test uses a fakeRunner so we can observe call ordering and prove
// Run() didn't return at any point during RestartAll. The
// processRunner interface boundary means a refactor back to
// StopProcess/StartProcess wouldn't even compile (those methods
// aren't on the interface), but we verify the positive case
// explicitly here so the contract is documented in code.
func TestSupervisorRestartAllUsesRestartProcess(t *testing.T) {
	var sd atomic.Bool
	fake := newFakeRunner()
	sup := &Supervisor{
		runner:       fake,
		shuttingDown: &sd,
		startedAt:    time.Now(),
	}

	runAndWatchDone := make(chan struct{})
	go func() {
		sup.runAndWatch()
		close(runAndWatchDone)
	}()
	if !waitFor(time.Second, func() bool { return fake.runStarted.Load() }) {
		t.Fatal("fakeRunner.Run() did not start within 1s")
	}

	if err := sup.RestartAll(); err != nil {
		t.Fatalf("RestartAll returned %v, want nil", err)
	}

	if got := fake.calls(); !slices.Equal(got, startOrder) {
		t.Errorf("RestartProcess calls = %v, want %v (startOrder)", got, startOrder)
	}
	if sup.SupervisorExited() {
		t.Error("SupervisorExited() = true after RestartAll, want false (Bug 3 regression: Run() exited mid-restart)")
	}
	if fake.runReturned.Load() {
		t.Error("fakeRunner.Run() returned during RestartAll — RestartAll let Run exit")
	}

	// Cleanup: trigger Run() to return so the goroutine exits before
	// the test does. shuttingDown=true tells runAndWatch this is a
	// graceful exit, not a watchdog event.
	sd.Store(true)
	if err := sup.Shutdown(); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	<-runAndWatchDone
	if sup.SupervisorExited() {
		t.Error("SupervisorExited() = true after graceful shutdown, want false")
	}
}

// TestSupervisorRestartAllPropagatesError verifies that a
// RestartProcess failure (other than "not running") surfaces as
// RestartAll's return value, while subsequent restarts still run.
// The old StopProcess+StartProcess shape had the same property; we
// keep it under the new RestartProcess loop.
func TestSupervisorRestartAllPropagatesError(t *testing.T) {
	var sd atomic.Bool
	fake := newFakeRunner()
	fake.restartProcErr = errFakeRestart
	sup := &Supervisor{
		runner:       fake,
		shuttingDown: &sd,
		startedAt:    time.Now(),
	}
	runAndWatchDone := make(chan struct{})
	go func() {
		sup.runAndWatch()
		close(runAndWatchDone)
	}()
	if !waitFor(time.Second, func() bool { return fake.runStarted.Load() }) {
		t.Fatal("fakeRunner.Run() did not start within 1s")
	}

	err := sup.RestartAll()
	if err == nil {
		t.Fatal("RestartAll returned nil, want propagated error")
	}
	// Even with errors, every service in startOrder should have been
	// attempted (matches the original loop's "first error wins, other
	// passes still run" contract).
	if got := fake.calls(); !slices.Equal(got, startOrder) {
		t.Errorf("RestartProcess calls = %v, want %v (every service still attempted)", got, startOrder)
	}

	sd.Store(true)
	_ = sup.Shutdown()
	<-runAndWatchDone
}

// TestSupervisorRestartGraceLifecycleAroundRestartAll pins the
// inRestart flag and lastRestartEndNano stamp from the Bug 2 fix.
// Both must be observable via RestartGraceActive at the right
// moments: false before any restart, true while RestartAll is in
// flight, and true for restartGraceWindow after it returns.
//
// Uses a blockingFakeRunner that blocks the first RestartProcess
// until the test releases it — that gives us a deterministic
// "RestartAll is in-flight" window to assert against.
func TestSupervisorRestartGraceLifecycleAroundRestartAll(t *testing.T) {
	var sd atomic.Bool
	released := atomic.Bool{}
	fake := &blockingFakeRunner{
		fakeRunner: fakeRunner{runDone: make(chan struct{})},
		block:      make(chan struct{}),
		released:   &released,
	}
	sup := &Supervisor{
		runner:       fake,
		shuttingDown: &sd,
		startedAt:    time.Now(),
	}
	runAndWatchDone := make(chan struct{})
	go func() {
		sup.runAndWatch()
		close(runAndWatchDone)
	}()
	if !waitFor(time.Second, func() bool { return fake.runStarted.Load() }) {
		t.Fatal("fakeRunner.Run() did not start within 1s")
	}

	if sup.RestartGraceActive() {
		t.Error("RestartGraceActive() = true before any restart, want false")
	}

	restartDone := make(chan error, 1)
	go func() { restartDone <- sup.RestartAll() }()

	// inRestart is set at the top of RestartAll, before any
	// RestartProcess call. Wait for it to flip — that's the
	// "RestartAll is in-flight" signal.
	if !waitFor(time.Second, func() bool { return sup.RestartGraceActive() }) {
		t.Fatal("RestartGraceActive didn't flip true within 1s of RestartAll start")
	}

	released.Store(true)
	close(fake.block)
	if err := <-restartDone; err != nil {
		t.Fatalf("RestartAll returned %v, want nil", err)
	}

	// Just past completion: still inside post-restart grace because
	// lastRestartEndNano was just stamped (now − 0s < restartGraceWindow).
	if !sup.RestartGraceActive() {
		t.Error("RestartGraceActive() = false immediately after RestartAll, want true (post-restart grace)")
	}

	sd.Store(true)
	_ = sup.Shutdown()
	<-runAndWatchDone
}

// blockingFakeRunner is fakeRunner with a one-shot blocker on
// RestartProcess so the test can observe in-flight state. The
// embedded fakeRunner gives us record-keeping + the same Run()
// blocking semantics; this wrapper only intercepts RestartProcess.
type blockingFakeRunner struct {
	fakeRunner
	block    chan struct{}
	released *atomic.Bool
}

func (b *blockingFakeRunner) RestartProcess(name string) error {
	if !b.released.Load() {
		<-b.block
	}
	return b.fakeRunner.RestartProcess(name)
}

// errFakeRestart is the synthetic error
// TestSupervisorRestartAllPropagatesError surfaces from
// RestartProcess so we can verify RestartAll propagates it.
var errFakeRestart = &fakeRestartError{}

type fakeRestartError struct{}

func (e *fakeRestartError) Error() string { return "fake restart failure" }
