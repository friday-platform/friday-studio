package tunnel

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/friday-platform/friday-studio/pkg/logger"
	"github.com/friday-platform/friday-studio/pkg/processkit"
)

// Constants tuned to match the TS implementation. Changing these is a
// behavior change visible to users running a sleep-prone laptop.
const (
	initialBackoff       = 1 * time.Second
	maxBackoff           = 30 * time.Second
	startupURLTimeout    = 30 * time.Second
	maxStartupRetries    = 5
	healthProbeInterval  = 30 * time.Second
	maxConsecutiveProbes = 2
)

// Options holds the Manager constructor params.
type Options struct {
	Port           int
	TunnelToken    string // empty = quick tunnel
	CloudflaredBin string // resolved binary path (caller does discovery)
	Logger         *logger.Logger
}

// Status is the value-snapshot returned to callers asking about
// tunnel state. Safe to share across goroutines (immutable copy).
type Status struct {
	URL          string
	Alive        bool
	RestartCount int
	LastProbeAt  time.Time
}

// Manager owns the cloudflared subprocess. Callers see only Start,
// Stop, Status. All state lives behind a mutex; the only goroutines
// inside are the supervisor + log readers.
type Manager struct {
	opts Options

	mu           sync.Mutex
	cmd          *exec.Cmd
	url          string
	alive        atomic.Bool
	restartCount int
	lastProbeAt  time.Time
	stopped      atomic.Bool
	connections  int  // edge-connection count from log parsing
	urlReady     bool // true once we've seen a URL or first connected event

	// generation increments on every successful connect(). Each Wait()
	// goroutine captures the gen at spawn time and only triggers a
	// reconnect if its gen still matches Manager.generation when the
	// process exits. Without this, a reconnect that succeeds leaves the
	// previous Wait goroutine alive — when the OLD cmd's pipe finally
	// closes, the stale Wait goroutine fires another reconnect, racing
	// the live one and exploding into hundreds of attempts per second.
	generation atomic.Int64
	// reconnecting guards scheduleReconnect from running concurrently.
	// The first Wait goroutine to fire on exit wins; subsequent
	// triggers (e.g. healthProbe escalating to reconnect at the same
	// moment) skip silently.
	reconnecting atomic.Bool
}

// New creates a Manager. Call Start to spawn cloudflared.
func New(opts Options) *Manager {
	if opts.Logger == nil {
		opts.Logger = logger.New("tunnel")
	}
	return &Manager{opts: opts}
}

// Status returns a snapshot.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{
		URL:          m.url,
		Alive:        m.alive.Load(),
		RestartCount: m.restartCount,
		LastProbeAt:  m.lastProbeAt,
	}
}

// URL returns the public tunnel URL (may be empty if not yet known).
func (m *Manager) URL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.url
}

// Start spawns cloudflared and blocks until either the first URL
// arrives (quick tunnel) / the first connection registers (token
// tunnel), or all maxStartupRetries are exhausted.
func (m *Manager) Start(ctx context.Context) error {
	delay := initialBackoff
	var lastErr error
	for attempt := 1; attempt <= maxStartupRetries; attempt++ {
		err := m.connect(ctx)
		if err == nil {
			go m.healthProbeLoop()
			return nil
		}
		lastErr = err
		m.opts.Logger.Warn("tunnel startup failed",
			"attempt", attempt,
			"max_attempts", maxStartupRetries,
			"next_retry_ms", delay.Milliseconds(),
			"error", err)
		if attempt < maxStartupRetries {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
			delay *= 2
			if delay > maxBackoff {
				delay = maxBackoff
			}
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("tunnel startup exhausted retries")
	}
	return lastErr
}

// connect spawns cloudflared once and waits for the first URL/connect
// event, returning success once the tunnel is up. Sets up the log
// readers + exit handler that drive the reconnect path.
func (m *Manager) connect(parentCtx context.Context) error {
	args := m.buildArgs()
	cmd := exec.Command(m.opts.CloudflaredBin, args...)
	processkit.SetSysProcAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start cloudflared: %w", err)
	}

	// Bump generation BEFORE storing cmd. The Wait goroutine spawned
	// below captures this gen; a stale Wait goroutine from the previous
	// cmd will see its captured gen != current and silently exit
	// without firing a reconnect.
	gen := m.generation.Add(1)

	m.mu.Lock()
	m.cmd = cmd
	m.url = ""
	m.urlReady = false
	m.connections = 0
	m.mu.Unlock()

	// urlCh is signaled either when we parse a quick-tunnel URL or
	// (for token tunnels) on the first EventConnected. Buffered so the
	// reader goroutine doesn't block if the supervisor is slow.
	urlCh := make(chan string, 1)
	events := make(chan Event, 64)

	go m.scan(stdout, events)
	go m.scan(stderr, events)
	go m.handleEvents(events, urlCh, cmd, gen)

	// Wait for either URL/connection signal or timeout.
	timer := time.NewTimer(startupURLTimeout)
	defer timer.Stop()
	select {
	case <-parentCtx.Done():
		_ = processkit.Kill(cmd.Process.Pid, 5*time.Second)
		return parentCtx.Err()
	case <-timer.C:
		_ = processkit.Kill(cmd.Process.Pid, 5*time.Second)
		return fmt.Errorf("timed out waiting for cloudflared URL")
	case url := <-urlCh:
		m.mu.Lock()
		m.url = url
		m.urlReady = true
		m.mu.Unlock()
		m.alive.Store(true)
		return nil
	}
}

func (m *Manager) buildArgs() []string {
	url := fmt.Sprintf("http://localhost:%d", m.opts.Port)
	if m.opts.TunnelToken != "" {
		// Named tunnel via token. cloudflared accepts the token via
		// `tunnel run --token <t>` (the npm wrapper uses the same
		// invocation). --url is ignored when the token's config defines
		// ingress, but doesn't error if present.
		return []string{"tunnel", "run", "--token", m.opts.TunnelToken, "--url", url}
	}
	// Quick tunnel: trycloudflare.com URL.
	return []string{"tunnel", "--url", url, "--no-autoupdate"}
}

// scan reads cloudflared lines from r and fans Event values into the
// shared events channel.
func (m *Manager) scan(r io.Reader, events chan<- Event) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		for _, ev := range parseLine(line, time.Now()) {
			select {
			case events <- ev:
			default:
				// Drop event if buffer full — startup-time burst should
				// fit in 64 entries; sustained backlog means the
				// supervisor goroutine is wedged, which is its own bug.
			}
		}
	}
}

// handleEvents drains the parser's event channel and updates manager
// state. urlCh is signaled on the first URL OR (for token tunnels) the
// first connected event — startup considers either ready.
//
// gen is the generation number assigned by connect() when this cmd was
// spawned. The Wait goroutine compares gen to Manager.generation when
// the process exits — if they don't match, a newer connect() superseded
// us and the reconnect should be the new gen's responsibility, not ours.
func (m *Manager) handleEvents(events <-chan Event, urlCh chan<- string, cmd *exec.Cmd, gen int64) {
	urlSent := false

	// Wait for cmd exit in parallel; surface as a synthetic EventExit.
	go func() {
		_ = cmd.Wait()
		if m.stopped.Load() {
			return
		}
		// Stale-generation check: if the manager has moved on to a
		// newer cmd, this is the OLD cmd's exit firing late — silently
		// drop. Without this check, a successful reconnect leaves the
		// previous Wait goroutine alive; when its pipe finally closes,
		// it would trigger another reconnect and race the live one.
		if m.generation.Load() != gen {
			return
		}
		m.opts.Logger.Warn("cloudflared exited", "generation", gen)
		m.alive.Store(false)
		go m.scheduleReconnect()
	}()

	for ev := range events {
		switch ev.Kind {
		case EventURL:
			if !urlSent {
				urlCh <- ev.URL
				urlSent = true
			}
		case EventConnected:
			m.mu.Lock()
			m.connections++
			m.mu.Unlock()
			m.opts.Logger.Info("cloudflared edge connection established", "total", m.connections)
			// Token tunnels never print a URL — first connected = ready.
			if !urlSent && m.opts.TunnelToken != "" {
				urlCh <- "" // unblocks Start; URL stays empty for token tunnels (CNAME → user-visible URL is the registered domain).
				urlSent = true
			}
		case EventDisconnected:
			m.mu.Lock()
			if m.connections > 0 {
				m.connections--
			}
			n := m.connections
			m.mu.Unlock()
			m.opts.Logger.Warn("cloudflared edge connection lost", "remaining", n)
		}
	}
}

// ctxDone returns a channel that's closed when Stop is called.
func (m *Manager) ctxDone() <-chan struct{} {
	if m.stopped.Load() {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	// stopped=false case: return a never-closing channel.
	return make(chan struct{})
}

// scheduleReconnect waits backoffSeconds then tries to reconnect.
// Increments restartCount on success.
//
// Singleton-guarded via m.reconnecting. The first caller wins; any
// concurrent caller (e.g. healthProbe escalating at the same moment
// as a Wait-handler firing) silently returns. The guard is cleared
// when this function exits — either after a successful reconnect or
// when the loop bottoms out (stopped, or context cancelled).
func (m *Manager) scheduleReconnect() {
	if !m.reconnecting.CompareAndSwap(false, true) {
		return
	}
	defer m.reconnecting.Store(false)

	delay := initialBackoff
	for {
		if m.stopped.Load() {
			return
		}
		m.opts.Logger.Info("scheduling tunnel reconnect", "delay_ms", delay.Milliseconds())
		time.Sleep(delay)
		if m.stopped.Load() {
			return
		}
		m.mu.Lock()
		m.restartCount++
		attempt := m.restartCount
		m.mu.Unlock()
		m.opts.Logger.Info("reconnecting tunnel", "attempt", attempt)
		if err := m.connect(context.Background()); err != nil {
			m.opts.Logger.Error("reconnect failed", "error", err, "next_retry_ms", delay.Milliseconds())
			delay *= 2
			if delay > maxBackoff {
				delay = maxBackoff
			}
			continue
		}
		m.opts.Logger.Info("tunnel reconnected", "url", m.URL(), "restart_count", attempt)
		go m.healthProbeLoop()
		return
	}
}

// healthProbeLoop runs every healthProbeInterval and triggers a
// reconnect if the cloudflared process is alive but has zero edge
// connections (the "post-laptop-sleep stalled QUIC" case).
func (m *Manager) healthProbeLoop() {
	ticker := time.NewTicker(healthProbeInterval)
	defer ticker.Stop()
	consecutiveFailures := 0
	for range ticker.C {
		if m.stopped.Load() {
			return
		}
		m.mu.Lock()
		m.lastProbeAt = time.Now()
		conns := m.connections
		alive := m.cmd != nil && m.cmd.Process != nil && m.cmd.ProcessState == nil
		m.mu.Unlock()

		ok := alive && conns > 0
		if ok {
			if consecutiveFailures > 0 {
				m.opts.Logger.Info("tunnel health probe recovered")
			}
			consecutiveFailures = 0
			m.alive.Store(true)
			continue
		}
		consecutiveFailures++
		m.opts.Logger.Warn("tunnel health probe failed",
			"alive", alive, "connections", conns,
			"consecutive", consecutiveFailures, "threshold", maxConsecutiveProbes)
		if consecutiveFailures >= maxConsecutiveProbes {
			m.opts.Logger.Error("tunnel appears dead, triggering reconnect")
			m.alive.Store(false)
			m.mu.Lock()
			cmd := m.cmd
			m.mu.Unlock()
			if cmd != nil && cmd.Process != nil {
				_ = processkit.Kill(cmd.Process.Pid, 5*time.Second)
			}
			// The Wait goroutine in handleEvents will trigger
			// scheduleReconnect; this loop exits to make way.
			return
		}
	}
}

// Stop terminates cloudflared. Idempotent.
func (m *Manager) Stop() {
	if !m.stopped.CompareAndSwap(false, true) {
		return
	}
	m.alive.Store(false)
	m.mu.Lock()
	cmd := m.cmd
	m.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = processkit.Kill(cmd.Process.Pid, 20*time.Second)
	}
}
