package main

// Native-Go readiness probe.
//
// Why we don't use process-compose's ReadinessProbe: its HttpProbe has
// no TLS controls — no way to inject a tls.Config or an http.Client.
// Our s2s leaf is private-CA-signed and our browser cert is mkcert-
// issued; both rejected by Go's default http.Transport. So we leave
// ReadinessProbe=nil and run our own probes here, end-to-end in stdlib.
//
// The whole point of this file is the explicit tls.Config below: we
// build one with InsecureSkipVerify=true (loopback only — we control
// both ends, plumbing per-service CA paths buys no real security on
// 127.0.0.1) and hand it to the http.Client used by every https probe.
//
// Lifecycle: main.go starts one readinessRunner per supervised spec
// after the supervisor is up. Each runner runs a goroutine that polls
// its target every probePeriodSeconds. Failure → restart: once a
// runner sees probeFailureThreshold consecutive failures it calls
// sup.RestartProcess(name) and resets so the post-restart cold-start
// window begins fresh.

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

// readinessTLSConfig is the tls.Config shared by every https probe.
// Single source of truth so a future refactor can't accidentally
// produce one https probe without skip-verify (which would silently
// fail every probe against our private-CA-signed services).
//
// InsecureSkipVerify is the deliberate choice for loopback readiness:
// the alternative (a *tls.Config with RootCAs pinned to our private CA)
// would require resolving the CA path at runtime, reading it on every
// scheme decision, and re-resolving when the renewer rotates certs.
// Skip-verify on 127.0.0.1 has no real security cost — there is no
// MITM surface — and the failure mode if we accidentally hit a real
// origin via this client is benign (we trust whatever cert it presents).
//
//nolint:gosec // G402: loopback-only readiness probe, see comment above
var readinessTLSConfig = &tls.Config{InsecureSkipVerify: true}

// readinessRunner drives the native readiness loop for one supervised
// service. One runner per process; the launcher spawns them after
// NewSupervisor returns and tears them down with the same context the
// rest of the launcher uses.
type readinessRunner struct {
	name   string
	url    string
	client *http.Client
	cache  *HealthCache
	sup    restarter

	// Tunables — copied from package-level constants at construction
	// so tests can override per-runner without flipping globals.
	initialDelay time.Duration
	period       time.Duration
	failureMax   int

	// Cap on launcher-driven restarts for the lifetime of this runner
	// (i.e. one launcher boot). process-compose's MaxRestarts gates its
	// own in-band restart loop but NOT external sup.RestartProcess
	// calls (see ProjectRunner.RestartProcess → doRestart in
	// process-compose; no Restarts < MaxRestarts check). Without this
	// per-runner cap a wedged service (port bound, /health hangs)
	// would get bounced every ~62s forever.
	restartMax int

	// Counters owned by the goroutine; no mutex needed.
	consecutiveFail int
	restartsIssued  int
	// badURLLogged guards the http.NewRequestWithContext error path
	// from spamming the log every probe period. r.url is fixed for the
	// runner's lifetime — if NewRequestWithContext rejects it once,
	// every subsequent call rejects it identically. Log once, then go
	// quiet but keep flipping the cache to !ready.
	badURLLogged bool
}

// restarter is the slice of *Supervisor that readinessRunner cares
// about, so unit tests can pass a fake instead of the real supervisor
// (which would need a live process-compose project).
type restarter interface {
	RestartProcess(name string) error
}

// newReadinessRunner builds a runner for one spec. The http.Client is
// reused across probe ticks so we get keepalive + connection-pool
// reuse on loopback. Timeout is enforced by the Client itself; we
// don't need per-tick contexts.
func newReadinessRunner(s processSpec, cache *HealthCache, sup restarter) *readinessRunner {
	scheme := s.healthScheme
	if scheme == "" {
		scheme = "http"
	}
	return &readinessRunner{
		name:         s.name,
		url:          fmt.Sprintf("%s://127.0.0.1:%s%s", scheme, s.healthPort, s.healthPath),
		client:       newReadinessClient(scheme),
		cache:        cache,
		sup:          sup,
		initialDelay: time.Duration(probeInitialDelay) * time.Second,
		period:       time.Duration(probePeriodSeconds) * time.Second,
		failureMax:   probeFailureThreshold,
		restartMax:   supervisedMaxRestarts,
	}
}

// newReadinessClient returns the http.Client the spec's runner should
// use. Plain HTTP gets a vanilla client (default transport, no
// allocation overhead). HTTPS gets a client whose transport carries
// readinessTLSConfig — the explicit knob this whole file exists for.
// Both share the same probeTimeoutSeconds timeout — there's no varied
// caller, so the value is hardcoded rather than threaded through.
//
// Note we clone http.DefaultTransport rather than constructing a fresh
// *http.Transport from scratch — keeps Go's standard connection pool /
// keepalive / proxy defaults and only overrides the TLS config.
func newReadinessClient(scheme string) *http.Client {
	timeout := time.Duration(probeTimeoutSeconds) * time.Second
	if scheme != "https" {
		return &http.Client{Timeout: timeout}
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = readinessTLSConfig
	return &http.Client{Timeout: timeout, Transport: tr}
}

// Run blocks on ctx; returns when ctx is cancelled. Spawn as a
// goroutine. Designed to be cheap: one http request per probePeriod.
func (r *readinessRunner) Run(ctx context.Context) {
	// Initial delay — matches process-compose's probe semantics. Gives
	// the service a chance to bind before we start counting failures
	// against it.
	select {
	case <-ctx.Done():
		return
	case <-time.After(r.initialDelay):
	}
	ticker := time.NewTicker(r.period)
	defer ticker.Stop()
	r.tick(ctx) // First tick happens immediately after initialDelay.
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.tick(ctx)
		}
	}
}

// tick performs one probe. 2xx is healthy (matches Kubernetes-style
// readiness semantics); everything else — connection refused, timeout,
// TLS handshake error, 4xx, 5xx — is a failure.
func (r *readinessRunner) tick(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url, nil)
	if err != nil {
		// Programmer error — bad URL. Same URL is reused every tick,
		// so a regression here would otherwise produce one log line
		// per probePeriodSeconds for the rest of the runner's life.
		// Log once, then go quiet; the cache flip below still fires
		// every tick so the operator gets a "starting forever" signal
		// in the UI even after we stop logging.
		if !r.badURLLogged {
			log.Error("readiness: bad probe URL", "service", r.name, "url", r.url, "error", err)
			r.badURLLogged = true
		}
		r.onFailure()
		return
	}
	resp, err := r.client.Do(req)
	if err != nil {
		r.onFailure()
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		r.onSuccess()
		return
	}
	r.onFailure()
}

func (r *readinessRunner) onSuccess() {
	if r.consecutiveFail != 0 {
		log.Debug("readiness: probe recovered", "service", r.name)
	}
	r.consecutiveFail = 0
	r.cache.SetReady(r.name, true)
}

func (r *readinessRunner) onFailure() {
	r.consecutiveFail++
	r.cache.SetReady(r.name, false)
	if r.consecutiveFail < r.failureMax {
		return
	}
	// Threshold breached. process-compose's MaxRestarts gates its own
	// in-band restart loop (crash + RestartPolicyAlways) but NOT
	// external sup.RestartProcess — ProjectRunner.RestartProcess →
	// doRestart unconditionally re-runs the process. Without the
	// per-runner cap below a wedged service (port bound, /health
	// hangs) would get bounced every ~62s for the rest of the
	// launcher's lifetime. Once we hit the cap we keep probing (so
	// the cache reflects truth + the launcher recovers if the
	// service comes back) but stop issuing restart requests.
	if r.restartsIssued >= r.restartMax {
		// Log once at the boundary so the operator notices, then go
		// quiet. consecutiveFail keeps climbing — that's intentional;
		// a downstream "the runner gave up" check can read it.
		if r.consecutiveFail == r.failureMax {
			log.Warn("readiness: restart cap reached, giving up on restarts",
				"service", r.name,
				"restarts_issued", r.restartsIssued,
				"restart_max", r.restartMax,
				"url", r.url,
			)
		}
		return
	}
	r.restartsIssued++
	log.Warn("readiness: failure threshold breached, requesting restart",
		"service", r.name,
		"consecutive_failures", r.consecutiveFail,
		"restarts_issued", r.restartsIssued,
		"restart_max", r.restartMax,
		"url", r.url,
	)
	if err := r.sup.RestartProcess(r.name); err != nil {
		log.Error("readiness: RestartProcess failed", "service", r.name, "error", err)
	}
	// Reset so the next post-restart cold-start window gets a fresh
	// failure budget. restartsIssued does NOT reset — it caps the
	// runner's lifetime restart count.
	r.consecutiveFail = 0
}

// startReadinessRunners spawns one goroutine per spec. The goroutines
// exit when ctx is cancelled, so the caller doesn't need to track
// them individually.
func startReadinessRunners(ctx context.Context, specs []processSpec, cache *HealthCache, sup restarter) {
	for _, s := range specs {
		go newReadinessRunner(s, cache, sup).Run(ctx)
	}
}
