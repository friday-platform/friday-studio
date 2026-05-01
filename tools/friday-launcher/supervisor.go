package main

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/f1bonacc1/process-compose/src/app"
	"github.com/f1bonacc1/process-compose/src/types"
)

// processRunner is the minimum subset of *app.ProjectRunner that
// Supervisor consumes. Pulled out as an interface so unit tests can
// inject a fake runner that records calls without spinning up real
// process-compose subprocesses. *app.ProjectRunner satisfies this
// implicitly (Go structural typing); production code passes one in
// via NewSupervisor.
type processRunner interface {
	Run() error
	RestartProcess(name string) error
	ShutDownProject() error
	GetProcessesState() (*types.ProcessesState, error)
}

// Supervisor wraps a process-compose ProjectRunner with the launcher's
// own state (started flag, supervisorExited watchdog, restart-all
// serialization).
type Supervisor struct {
	runner processRunner

	supervisorExited atomic.Bool
	shuttingDown     *atomic.Bool

	startedAt time.Time

	restartMu sync.Mutex // serializes Restart-all paths

	// inRestart is true from the start of RestartAll until it
	// returns. lastRestartEndNano is the unix-nano timestamp at
	// which the most recent RestartAll returned; zero before the
	// first restart. Together they drive the post-restart grace
	// window in RestartGraceActive — the tray uses it to suppress
	// the red "Error" badge while children are restarting and
	// re-passing readiness probes. Atomics so the tray-poll
	// goroutine can read without taking restartMu.
	inRestart          atomic.Bool
	lastRestartEndNano atomic.Int64
}

// NewSupervisor builds the project + ProjectOpts and instantiates the
// runner. Does NOT call Run() — that's the caller's responsibility
// (typically via runAndWatch in a goroutine).
func NewSupervisor(project *types.Project, shuttingDown *atomic.Bool) (*Supervisor, error) {
	opts := (&app.ProjectOpts{}).
		WithProject(project).
		WithIsTuiOn(false).
		WithOrderedShutdown(true).
		WithDotEnvDisabled(true)
	runner, err := app.NewProjectRunner(opts)
	if err != nil {
		return nil, err
	}
	return &Supervisor{
		runner:       runner,
		shuttingDown: shuttingDown,
		startedAt:    time.Now(),
	}, nil
}

// runAndWatch invokes runner.Run() and observes its return. If Run()
// returns when we did NOT initiate shutdown, mark supervisorExited so
// the tray-poll loop can render RED.
//
// runner.Run() is supposed to block for the lifetime of the launcher.
// Verified at process-compose/src/app/project_runner.go:88-184: the
// loop only exits on ctxApp.Done(), all-processes-completed, or
// scheduled-only states. If a child supervision goroutine inside
// process-compose panics without propagating, Run() stays blocked
// forever — that's a documented limitation (see v8 plan Out of Scope).
func (s *Supervisor) runAndWatch() {
	_ = s.runner.Run()
	if !s.shuttingDown.Load() {
		s.supervisorExited.Store(true)
	}
}

// SupervisorExited reports whether runner.Run() returned unexpectedly.
func (s *Supervisor) SupervisorExited() bool {
	return s.supervisorExited.Load()
}

// State proxies through to runner.GetProcessesState. May return cached
// (stale) data if the supervisor exited unexpectedly — callers should
// check SupervisorExited() first.
func (s *Supervisor) State() (*types.ProcessesState, error) {
	return s.runner.GetProcessesState()
}

// Shutdown calls runner.ShutDownProject() with no extra wrapping; the
// caller is responsible for the goroutine + 30s deadline pattern that
// keeps the macOS NSApp event loop unblocked.
func (s *Supervisor) Shutdown() error {
	return s.runner.ShutDownProject()
}

// RestartAll restarts every supervised process by calling
// runner.RestartProcess(name) in startOrder (dependency order so
// foundational services come back first).
//
// Why per-process RestartProcess and not the older two-pass
// "StopProcess everything then StartProcess everything":
// process-compose's runner.Run loop terminates with "Project
// completed" when runProcCount hits 0 AND no entries are present in
// the runner's restartCalls map (process_runner.go:151-180 in
// process-compose v1.103.0). The old two-pass shape never touched
// restartCalls, so the moment between the last StopProcess and the
// first StartProcess satisfied both conditions: Run() returned,
// runAndWatch latched supervisorExited=true, and the tray painted
// red forever even though StartProcess immediately brought all
// children back up. RestartProcess registers an entry in
// restartCalls for the duration of each call, so pendingRestarts > 0
// blocks the project-completed branch — Run() stays in its loop.
//
// As a bonus the new shape keeps four of five services running at
// any moment (sequential restart vs. all-down-then-all-up), so a
// user-initiated Restart no longer has a window where every port is
// closed.
//
// Serialized via restartMu so concurrent menu clicks don't race.
// Returns the first error encountered (other restarts still run).
// Sets inRestart for the duration and stamps lastRestartEndNano on
// completion — RestartGraceActive consults both so the tray can
// suppress the red bucket while children are coming back.
func (s *Supervisor) RestartAll() error {
	s.restartMu.Lock()
	defer s.restartMu.Unlock()

	s.inRestart.Store(true)
	defer func() {
		s.lastRestartEndNano.Store(time.Now().UnixNano())
		s.inRestart.Store(false)
	}()

	var firstErr error
	for _, name := range startOrder {
		if err := s.runner.RestartProcess(name); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// StartedAt returns when the supervisor was created (used by the tray
// for the cold-start grace window).
func (s *Supervisor) StartedAt() time.Time { return s.startedAt }

// restartGraceWindow is how long after a RestartAll the tray treats
// "AnyFailed" as still-recovering rather than red. Set equal to
// bucketFailGraceWindow so a user-initiated restart gets the same
// forgiveness as a fresh launcher boot — children stop, readiness
// probes go un-ready, then come back over the readiness budget
// (project.go: 2s + 30 retries × 2s = 62s worst case for the slow
// process; the 90s window covers that with VM/slow-disk slack).
const restartGraceWindow = bucketFailGraceWindow

// RestartGraceActive reports whether the tray should treat the
// current health snapshot through the lens of a recent restart
// (i.e. "AnyFailed" is expected, don't paint red). True while a
// RestartAll is in flight, and for restartGraceWindow after it
// returns. Decouples from StartedAt so subsequent restarts get
// their own grace, not just the cold-start one.
func (s *Supervisor) RestartGraceActive() bool {
	if s.inRestart.Load() {
		return true
	}
	endNano := s.lastRestartEndNano.Load()
	if endNano == 0 {
		return false
	}
	return time.Since(time.Unix(0, endNano)) < restartGraceWindow
}
