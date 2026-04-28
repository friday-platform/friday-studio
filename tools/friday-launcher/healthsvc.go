package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/f1bonacc1/process-compose/src/types"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// healthServerPort is the loopback HTTP port on which the launcher
// exposes /api/launcher-health (GET + SSE) and /api/launcher-shutdown
// (POST). Hardcoded — documented in CLAUDE.md so accidental reuse is
// caught at code-review time, not at runtime.
const healthServerPort = "5199"

// healthServerAddr is the full bind address. 127.0.0.1 only —
// loopback ensures the endpoint isn't reachable from the network and
// the POST shutdown handler doesn't need auth.
const healthServerAddr = "127.0.0.1:" + healthServerPort

// healthPollInterval is how often the cache-update goroutine reads
// supervisor.State() and recomputes per-service status. 500ms is
// fast enough for the wizard's checklist UX without burning CPU on
// the host.
const healthPollInterval = 500 * time.Millisecond

// supervisedMaxRestarts is the per-service restart cap configured in
// project.go's RestartPolicyConfig. deriveStatus reads the same value
// to flip a service to "failed" once process-compose has exhausted
// restarts. Both sites must agree — if they drift, services either
// get marked failed too early (restarts < cap → "failed") or never
// (restarts >= cap → still "starting"). Single const enforces it.
const supervisedMaxRestarts = 5

// maxSubscribers caps concurrent SSE subscriber registrations.
// Loopback-only mitigates the threat surface, but a misbehaving
// local client could otherwise open thousands of connections and
// pin RAM. Subscribe() rejects past this bound.
const maxSubscribers = 100

// ServiceStatus is one row of the per-service health checklist
// returned by GET /api/launcher-health. Fields match the JSON shape
// documented in v15 § cross-cutting.
type ServiceStatus struct {
	Name      string `json:"name"`
	Status    string `json:"status"`     // "pending" | "starting" | "healthy" | "failed"
	SinceSecs int64  `json:"since_secs"` // seconds since last transition into Status
}

// Per-service status values served on the wire. Match v15's documented
// state-machine vocabulary.
const (
	statusPending  = "pending"
	statusStarting = "starting"
	statusHealthy  = "healthy"
	statusFailed   = "failed"
)

// serviceState is the cached internal record for one supervised
// service. transitionAt is the time we first observed the current
// status; SinceSecs in the on-the-wire snapshot is computed from it
// at marshal time so the SSE event payload always reflects "seconds
// since last transition" without the writer having to recompute on
// every poll.
type serviceState struct {
	name         string
	status       string
	transitionAt time.Time
}

// HealthCache is the launcher's per-service health record + SSE
// fan-out hub. It is the single source of truth read by:
//   - the tray bucket logic (computeBucket)
//   - the GET /api/launcher-health handler
//   - the GET /api/launcher-health/stream SSE handler
//   - the POST /api/launcher-shutdown handler (via shuttingDown)
//
// Concurrency model: single writer (the 500ms-poll goroutine, see
// runHealthPoll), many readers (HTTP handlers + tray). RWMutex
// enforces the discipline. Snapshot() copies the slice under the
// read lock and never holds it across JSON encoding so a slow
// SSE consumer can't block the poll goroutine.
type HealthCache struct {
	mu        sync.RWMutex
	services  []serviceState
	startedAt time.Time

	// shuttingDown is owned by main.go (the GLOBAL shutdown atomic).
	// HealthCache holds a pointer so the HTTP handler's 409-conflict
	// probe and the tray's "Shutting down…" rendering both read the
	// same source of truth (Decision #33). HealthCache never writes
	// to it; performShutdown is the only writer.
	shuttingDown *atomic.Bool

	// SSE fan-out. Each connected subscriber registers a chan struct{};
	// the writer iterates and uses non-blocking select{} so a slow
	// subscriber doesn't block other subscribers or the writer itself.
	// Separate sub-mutex so registration/deregistration doesn't
	// contend with the main read path.
	subsMu sync.Mutex
	subs   map[chan struct{}]struct{}
}

// NewHealthCache returns a HealthCache that reads the global
// shuttingDown atomic. The caller is responsible for spawning the
// poll goroutine (runHealthPoll) and for calling Update from it.
func NewHealthCache(shuttingDown *atomic.Bool) *HealthCache {
	return &HealthCache{
		startedAt:    time.Now(),
		shuttingDown: shuttingDown,
		subs:         make(map[chan struct{}]struct{}),
	}
}

// Update is the writer entry point. Called from the 500ms-poll
// goroutine with the latest ProcessesState from process-compose.
// Translates each process's (Status, Health, Restarts) into our
// state-machine vocabulary, updates transitionAt only when the
// status actually changes, and fans out a notification to SSE
// subscribers if anything transitioned.
//
// Order is preserved: services appear in the slice in the same order
// process-compose returns them, which matches the order they were
// added to the project (i.e. supervisedProcesses() declaration
// order). Determines the order of rows in the wizard's checklist.
func (c *HealthCache) Update(snapshot *types.ProcessesState) {
	if snapshot == nil {
		return
	}
	now := time.Now()

	c.mu.Lock()
	changed := false
	if len(c.services) == 0 {
		// First observation. Seed entries directly from snapshot
		// order; transitionAt = now for every entry (state machine
		// "since" semantics: time since the launcher first observed
		// the current status, not since process-compose declared it).
		c.services = make([]serviceState, 0, len(snapshot.States))
		for _, ps := range snapshot.States {
			c.services = append(c.services, serviceState{
				name:         ps.Name,
				status:       deriveStatus(ps),
				transitionAt: now,
			})
		}
		changed = len(c.services) > 0
	} else {
		// Subsequent updates. Match by name; the snapshot is small
		// (6 supervised services) so O(n*m) lookup is fine. If a
		// new service appeared (shouldn't happen post-startup but
		// future-proof), append it.
		for _, ps := range snapshot.States {
			derived := deriveStatus(ps)
			i := indexByName(c.services, ps.Name)
			if i < 0 {
				c.services = append(c.services, serviceState{
					name:         ps.Name,
					status:       derived,
					transitionAt: now,
				})
				changed = true
				continue
			}
			if c.services[i].status != derived {
				c.services[i].status = derived
				c.services[i].transitionAt = now
				changed = true
			}
		}
	}
	c.mu.Unlock()

	if changed {
		c.notifySubscribers()
	}
}

func indexByName(svcs []serviceState, name string) int {
	for i := range svcs {
		if svcs[i].name == name {
			return i
		}
	}
	return -1
}

// deriveStatus translates a process-compose ProcessState into our
// state-machine vocabulary. Documented in v15 § Service status state
// machine.
//
// Mapping rules:
//   - Status==Pending or Status==Disabled → "pending" (process not
//     yet spawned by the supervisor)
//   - Status==Error AND Restarts >= MaxRestarts → "failed"
//     (terminal until user clicks Restart-all)
//   - Status==Running AND Health==Ready → "healthy"
//   - everything else (Running+NotReady, Launching, Launched,
//     Restarting, Terminating, Completed-with-nonzero-exit) →
//     "starting"
//
// We treat "Restarting" as a transient amber rather than red — the
// wizard checklist shows a spinner and the tray stays amber for the
// 30s cold-start grace window. Failed is terminal (the user has to
// take action), distinct from a single SIGKILL+restart that
// process-compose handles internally under MaxRestarts.
func deriveStatus(ps types.ProcessState) string {
	switch ps.Status {
	case types.ProcessStatePending, types.ProcessStateDisabled, types.ProcessStateScheduled:
		return statusPending
	case types.ProcessStateError:
		// process-compose flips to Status=Error AFTER restarts are
		// exhausted, so this branch fires when the service has
		// hit the terminal state.
		if ps.Restarts >= supervisedMaxRestarts {
			return statusFailed
		}
		return statusStarting
	case types.ProcessStateCompleted:
		// Completed is "ran to clean exit". For supervised servers
		// (which should run forever) Completed counts as failed.
		// ExitCode == 0 means clean exit; nonzero means it crashed.
		// Either way, a server that exited isn't healthy. Restarts
		// gating mirrors the Error branch.
		if ps.Restarts >= supervisedMaxRestarts {
			return statusFailed
		}
		return statusStarting
	case types.ProcessStateRunning:
		if !ps.HasHealthProbe {
			// No health probe declared for this service: treat
			// Running as healthy. Today every supervised service
			// has a probe, so this branch is defensive.
			return statusHealthy
		}
		if ps.Health == types.ProcessHealthReady {
			return statusHealthy
		}
		return statusStarting
	default:
		// Launching, Launched, Restarting, Terminating, Foreground, etc.
		return statusStarting
	}
}

// Snapshot returns a copy of the current per-service status array
// with SinceSecs computed at call time. Safe to marshal/iterate
// without holding a lock. Also returns the cache uptime and the
// shuttingDown flag at the same instant so handlers don't see a
// torn read of "services" vs "shutting_down".
func (c *HealthCache) Snapshot() (services []ServiceStatus, uptimeSecs int64, shuttingDown bool) {
	now := time.Now()
	c.mu.RLock()
	defer c.mu.RUnlock()

	services = make([]ServiceStatus, len(c.services))
	for i, s := range c.services {
		services[i] = ServiceStatus{
			Name:      s.name,
			Status:    s.status,
			SinceSecs: int64(now.Sub(s.transitionAt).Seconds()),
		}
	}
	uptimeSecs = int64(now.Sub(c.startedAt).Seconds())
	shuttingDown = c.shuttingDown.Load()
	return services, uptimeSecs, shuttingDown
}

// AllHealthy returns true iff every cached service is "healthy".
// False if there are no services yet (cache hasn't received its
// first Update). Used by the tray bucket logic AND the
// `all_healthy` field of GET /api/launcher-health.
func (c *HealthCache) AllHealthy() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.services) == 0 {
		return false
	}
	for _, s := range c.services {
		if s.status != statusHealthy {
			return false
		}
	}
	return true
}

// AnyFailed returns true if any cached service is in the terminal
// "failed" state. Used by the tray bucket to render RED past the
// cold-start grace window.
func (c *HealthCache) AnyFailed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, s := range c.services {
		if s.status == statusFailed {
			return true
		}
	}
	return false
}

// UptimeSecs returns seconds since the cache was created. Used by
// the tray's "30s cold-start grace" check (computeBucket stays
// amber even with failed services until uptime exceeds 30s).
func (c *HealthCache) UptimeSecs() int64 {
	return int64(time.Since(c.startedAt).Seconds())
}

// Subscribe registers a notification channel for SSE fan-out.
// The returned channel receives an empty struct whenever any
// service transitions into a new state (including the initial
// observation). The caller must call Unsubscribe to drain the
// registration when done — typically deferred at the top of an
// SSE handler.
//
// Buffer size is 1: if the writer fires while the consumer hasn't
// drained the previous tick, the second tick is coalesced (the
// consumer will read one buffered tick and re-snapshot). This is
// fine because SSE consumers always re-Snapshot() on tick to get
// the current state, not a delta.
//
// Returns nil if maxSubscribers is reached. Callers must check.
func (c *HealthCache) Subscribe() chan struct{} {
	c.subsMu.Lock()
	defer c.subsMu.Unlock()
	if len(c.subs) >= maxSubscribers {
		return nil
	}
	ch := make(chan struct{}, 1)
	c.subs[ch] = struct{}{}
	return ch
}

// Unsubscribe removes a channel from the fan-out set. Idempotent:
// calling on an already-removed channel is safe. The channel itself
// is closed so any blocked read returns immediately.
func (c *HealthCache) Unsubscribe(ch chan struct{}) {
	c.subsMu.Lock()
	if _, ok := c.subs[ch]; ok {
		delete(c.subs, ch)
		close(ch)
	}
	c.subsMu.Unlock()
}

// notifySubscribers fires non-blocking sends on every registered
// channel. Slow subscribers fall behind silently — the writer never
// blocks. Called from Update() only when at least one service
// transitioned.
func (c *HealthCache) notifySubscribers() {
	c.subsMu.Lock()
	defer c.subsMu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- struct{}{}:
		default:
			// Subscriber's buffer is full (it hasn't drained the
			// prior tick yet). Drop this tick — the consumer will
			// re-Snapshot on the next tick anyway.
		}
	}
}

// healthResponse is the JSON shape served by GET /api/launcher-health.
// Matches the contract documented in v15 § cross-cutting endpoint
// surface so installer + tooling can rely on it stably.
type healthResponse struct {
	UptimeSecs   int64           `json:"uptime_secs"`
	Services     []ServiceStatus `json:"services"`
	AllHealthy   bool            `json:"all_healthy"`
	ShuttingDown bool            `json:"shutting_down"`
}

// handleHealth returns the GET /api/launcher-health handler.
// During shutdown returns 503 with shutting_down: true so polling
// clients see the transition cleanly. Otherwise 200 + JSON.
func handleHealth(c *HealthCache) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		services, uptime, shuttingDown := c.Snapshot()
		body := healthResponse{
			UptimeSecs:   uptime,
			Services:     services,
			AllHealthy:   c.AllHealthy(),
			ShuttingDown: shuttingDown,
		}
		w.Header().Set("Content-Type", "application/json")
		if shuttingDown {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		if err := json.NewEncoder(w).Encode(body); err != nil {
			// Connection probably already closed by the peer (status
			// already written). Log and move on.
			log.Warn("health response encode failed", "error", err)
		}
	}
}

// handleHealthStream returns the GET /api/launcher-health/stream
// handler — Server-Sent Events. Subscribes to the cache fan-out,
// emits an initial snapshot, then re-emits the full snapshot on
// every state-change tick. On shutdown sends one final
// {"shutting_down": true} event before closing.
//
// We re-emit the FULL snapshot rather than deltas because consumers
// (the wizard's wait-healthy step) re-render the whole checklist
// per event anyway. Simpler protocol; smaller surface for bugs.
//
// HTTP/1.1 keepalive + chunked encoding is what go's net/http
// emits by default for streaming responses; we just need to
// Flush() after each event so the wizard sees them in real time.
func handleHealthStream(c *HealthCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		// X-Accel-Buffering off is for nginx-style proxies; harmless
		// on direct loopback but documents the expectation.
		w.Header().Set("X-Accel-Buffering", "no")

		ch := c.Subscribe()
		if ch == nil {
			http.Error(w, "subscriber limit reached", http.StatusServiceUnavailable)
			return
		}
		defer c.Unsubscribe(ch)

		emit := func() bool {
			services, uptime, shuttingDown := c.Snapshot()
			body := healthResponse{
				UptimeSecs:   uptime,
				Services:     services,
				AllHealthy:   c.AllHealthy(),
				ShuttingDown: shuttingDown,
			}
			payload, err := json.Marshal(body)
			if err != nil {
				log.Warn("SSE marshal failed", "error", err)
				return false
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}

		// Initial snapshot. The wizard depends on receiving this
		// even if no service has transitioned since subscribe; the
		// alternative ("wait for first transition before emitting")
		// would leave the wizard with a blank checklist on services
		// that came up before subscribe.
		//
		// Drain any tick that arrived between Subscribe and the
		// initial emit — otherwise the loop below would re-emit the
		// same snapshot a second time. (`select default` makes this
		// non-blocking; if no tick is queued we fall through.)
		select {
		case <-ch:
		default:
		}
		if !emit() {
			return
		}

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				// Client disconnected (or srv.Shutdown cancelled
				// the request context) — exit so Unsubscribe runs.
				return
			case <-ch:
				if !emit() {
					return
				}
			}
		}
	}
}

// handleShutdown returns the POST /api/launcher-shutdown handler.
// Decision #33 alignment: we DO NOT add a CAS gate here. The
// existing performShutdown() owns the single one-shot CAS via
// shutdownStarted. This handler just probes the visibility flag
// to return 409 to a concurrent HTTP caller, then kicks off the
// shutdown in a goroutine and returns 202 immediately.
//
// 5s read timeout is enforced server-side by ReadHeaderTimeout on
// the http.Server; clients that get a 202 must not assume the work
// is done — they poll launcher.pid for removal.
func handleShutdown(c *HealthCache, perform func(reason string)) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if c.shuttingDown.Load() {
			http.Error(w, "shutdown already in progress", http.StatusConflict)
			return
		}
		w.Header().Set("Location", "/api/launcher-health")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"shutdown initiated"}`))
		// performShutdown blocks for up to 30s while supervisor
		// teardown runs. Spawn a goroutine so the HTTP response
		// returns immediately. The handler-vs-Shutdown deadlock
		// (http.Server.Shutdown waits for in-flight handlers) is
		// avoided because by the time srv.Shutdown(ctx) is called
		// (last step of performShutdown, after sweep) this handler
		// has long since returned.
		go perform("http:shutdown")
	}
}

// startHealthServer binds the loopback HTTP listener, registers
// handlers, and starts serving in a goroutine. Returns the
// http.Server so the caller can chain srv.Shutdown(ctx) into the
// shutdown sequence (performShutdown's last step, after sweep —
// see Decision #18 lifecycle).
//
// Bind error semantics: net.Listen runs synchronously so the
// caller surfaces port-in-use as a hard failure BEFORE the tray
// boots. main.go is responsible for translating the error into
// the osascript dialog (Decision #28) and exiting non-zero.
func startHealthServer(
	cache *HealthCache,
	perform func(reason string),
) (*http.Server, error) {
	r := chi.NewRouter()
	// Panic recovery so a future handler bug doesn't kill the server
	// goroutine and leave the health endpoint silently unreachable.
	r.Use(middleware.Recoverer)
	r.Get("/api/launcher-health", handleHealth(cache))
	r.Get("/api/launcher-health/stream", handleHealthStream(cache))
	r.Post("/api/launcher-shutdown", handleShutdown(cache, perform))

	srv := &http.Server{
		Addr:              healthServerAddr,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return nil, fmt.Errorf("bind %s: %w", healthServerAddr, err)
	}
	go func() {
		if err := srv.Serve(ln); err != nil &&
			!errors.Is(err, http.ErrServerClosed) {
			log.Error("health HTTP server error", "error", err)
		}
	}()
	return srv, nil
}

// runHealthPoll is the cache-update goroutine. Reads
// supervisor.State() every healthPollInterval and pushes into
// HealthCache.Update. Exits when stop is signalled (typically
// performShutdown closes the supervisor before bringing down the
// HTTP server, so this goroutine hits a few stale reads then exits).
func runHealthPoll(
	ctx context.Context,
	sup *Supervisor,
	cache *HealthCache,
) {
	ticker := time.NewTicker(healthPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			state, err := sup.State()
			if err != nil || state == nil {
				continue
			}
			cache.Update(state)
		}
	}
}
