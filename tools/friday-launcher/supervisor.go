package main

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/f1bonacc1/process-compose/src/app"
	"github.com/f1bonacc1/process-compose/src/types"
)

// Supervisor wraps a process-compose ProjectRunner with the launcher's
// own state (started flag, supervisorExited watchdog, restart-all
// serialization).
type Supervisor struct {
	runner *app.ProjectRunner

	supervisorExited atomic.Bool
	supervisorErr    atomic.Value // error
	shuttingDown     *atomic.Bool

	startedAt time.Time

	restartMu sync.Mutex // serializes Restart-all paths
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
	err := s.runner.Run()
	if !s.shuttingDown.Load() {
		if err != nil {
			s.supervisorErr.Store(err)
		} else {
			s.supervisorErr.Store(errors.New("supervisor exited without error"))
		}
		s.supervisorExited.Store(true)
	}
}

// SupervisorExited reports whether runner.Run() returned unexpectedly.
func (s *Supervisor) SupervisorExited() bool {
	return s.supervisorExited.Load()
}

// SupervisorErr returns the recorded error if SupervisorExited() is true.
func (s *Supervisor) SupervisorErr() error {
	v := s.supervisorErr.Load()
	if v == nil {
		return nil
	}
	if e, ok := v.(error); ok {
		return e
	}
	return nil
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

// RestartAll runs the two-pass restart in stopOrder then startOrder.
// Serialized via restartMu so concurrent menu clicks don't race.
// Returns the first error encountered (other passes still run).
func (s *Supervisor) RestartAll() error {
	s.restartMu.Lock()
	defer s.restartMu.Unlock()

	var firstErr error
	for _, name := range stopOrder {
		// StopProcess blocks for up to ShutDownParams.ShutDownTimeout
		// seconds (we set 10), then SIGKILLs and returns. If the
		// process is not currently running (e.g. crashed and not yet
		// restarted) StopProcess returns "process is not running"
		// which we treat as success for the restart-all path.
		if err := s.runner.StopProcess(name); err != nil &&
			firstErr == nil {
			// Don't propagate "not running" — that's expected for
			// processes that crashed and haven't been restarted yet.
			if !isNotRunningErr(err) {
				firstErr = err
			}
		}
	}
	for _, name := range startOrder {
		if err := s.runner.StartProcess(name); err != nil &&
			firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// isNotRunningErr returns true if err is process-compose's
// "process X is not running" error from StopProcess. Treated as
// non-fatal during restart-all (process crashed and will be restarted
// by RestartPolicyAlways anyway).
func isNotRunningErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "is not running") ||
		strings.Contains(msg, "does not exist")
}

// StartedAt returns when the supervisor was created (used by the tray
// for the cold-start grace window).
func (s *Supervisor) StartedAt() time.Time { return s.startedAt }
