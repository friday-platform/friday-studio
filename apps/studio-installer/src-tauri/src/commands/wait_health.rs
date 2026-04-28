//! Wait-healthy SSE relay for the wizard's Launch step.
//!
//! Subscribes to the launcher's `/api/launcher-health/stream` endpoint
//! and forwards each event to the frontend via a Tauri Channel. The
//! launcher's stream emits a full snapshot per event (not deltas), so
//! the consumer just re-renders the checklist from the latest payload.
//!
//! Three deadlines, all independent:
//!   - **20s SSE-connect deadline** (capped exponential backoff
//!     200ms → 2s). Sized for cold-cache LaunchServices on slow Macs
//!     after the v0.0.8 → v0.0.9 migration.
//!   - **60s soft deadline** — UI swaps to "taking longer than usual"
//!     copy + adds "Wait 60s more" button.
//!   - **90s hard deadline** (default end). Extendable to 150s via
//!     `extend_wait_deadline`, then to 210s on a second extension.
//!
//! Past the hard deadline the wait does NOT return — it parks on a
//! `Notify` so a subsequent `extend_wait_deadline` can wake the loop
//! and resume waiting (the v15 plan's "Wait again" affordance only
//! makes sense if extension actually resumes the wait). The loop only
//! returns on a terminal event (all-healthy, unreachable, EOF, or a
//! supersede from a re-entered wizard).

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{Mutex, Notify};
use tokio::time::sleep;

/// Where the launcher's health endpoint lives. Hardcoded to match
/// `tools/friday-launcher/healthsvc.go`'s `healthServerAddr` const.
/// Test-only override hook lives below.
const LAUNCHER_HEALTH_URL: &str = "http://127.0.0.1:5199/api/launcher-health/stream";

/// SSE-connect retry budget. Sized for cold-cache LaunchServices
/// spin-up + Mach-O load + supervisor init on slow Macs (~6-8s
/// observed on v0.0.8 → v0.0.9 migration). 20s gives plenty of
/// headroom; a launcher that hasn't bound port 5199 in 20s is
/// broken in a way that's not a race.
const SSE_CONNECT_DEADLINE: Duration = Duration::from_secs(20);

/// Initial backoff when SSE connect fails. Doubles each retry up
/// to `SSE_BACKOFF_MAX_MS`. Common case: launcher binds within
/// ~200-500ms of spawn, first retry succeeds.
const SSE_BACKOFF_INITIAL_MS: u64 = 200;
const SSE_BACKOFF_MAX_MS: u64 = 2000;

/// Soft deadline — UI swaps to long-wait copy + "Wait 60s more"
/// button appears. The wait-healthy work continues in the
/// background; the deadline is purely a UI affordance.
const SOFT_DEADLINE_SECS: u64 = 60;

/// Hard deadline — default end of the wait-healthy step. Each
/// `extend_wait_deadline` call adds `EXTENSION_SECS`, capped at
/// `MAX_EXTENSIONS` total. Past the hard deadline the wizard
/// surfaces View logs / Open anyway / Wait again; the wait loop
/// itself parks on a Notify until extension wakes it.
const HARD_DEADLINE_SECS: u64 = 90;
const EXTENSION_SECS: u64 = 60;
const MAX_EXTENSIONS: u32 = 2;

/// Cap stream-read poll cadence. Drives how often the loop wakes
/// to re-check the soft/hard deadlines and the cancellation flag.
/// 1s is fine for a single-user wizard — fast enough that the
/// frontend sees timeout events promptly, slow enough not to spin.
const STREAM_POLL_CAP: Duration = Duration::from_secs(1);

/// Per-service status emitted by the launcher. Mirrors
/// `ServiceStatus` in `tools/friday-launcher/healthsvc.go`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServiceStatus {
    pub name: String,
    pub status: String, // "pending" | "starting" | "healthy" | "failed"
    #[serde(rename = "since_secs")]
    pub since_secs: i64,
}

/// Full snapshot from the launcher's health endpoint. Mirrors
/// `healthResponse` in `healthsvc.go`. The launcher emits this per
/// SSE event; we forward unchanged to the frontend.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HealthSnapshot {
    #[serde(rename = "uptime_secs")]
    pub uptime_secs: i64,
    pub services: Vec<ServiceStatus>,
    #[serde(rename = "all_healthy")]
    pub all_healthy: bool,
    #[serde(rename = "shutting_down")]
    pub shutting_down: bool,
}

/// Tagged events sent to the frontend Channel. The frontend's
/// `runtime.invoke('wait_for_services', { onEvent })` pattern reads
/// these one-at-a-time; the variant tag drives the UI state.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HealthEvent {
    /// Initial state — emitted once before the SSE-connect loop runs.
    /// Lets the frontend show "Connecting to launcher…" before the
    /// first snapshot lands.
    Connecting,
    /// SSE stream is live. Subsequent `Snapshot` events follow.
    Connected,
    /// Health snapshot from the launcher.
    Snapshot(HealthSnapshot),
    /// Soft deadline (60s) elapsed. UI swaps to long-wait copy.
    SoftDeadline,
    /// Hard deadline elapsed. Carries the names of services NOT
    /// healthy + a flag indicating whether playground is among the
    /// healthy ones (used by the partial-success "Open anyway" rule).
    Timeout {
        stuck: Vec<String>,
        playground_healthy: bool,
    },
    /// SSE-connect retry budget exhausted, stream closed
    /// unexpectedly, or stream errored mid-flight. Frontend shows
    /// "could not connect to launcher" + View logs.
    Unreachable {
        reason: String,
    },
    /// Launcher reported `shutting_down: true` in a snapshot. Treat
    /// as terminal — the user manually triggered a shutdown or
    /// something else hit the launcher's HTTP shutdown endpoint.
    /// Reserved for the snapshot-flag path; raw EOFs go through
    /// `Unreachable` since EOF doesn't distinguish orderly shutdown
    /// from a launcher crash.
    ShuttingDown,
}

/// Service name we treat as the user-facing surface for the
/// partial-success "Open anyway" rule. Centralised here so the
/// timeout-event builder and the frontend gate agree.
const PLAYGROUND_SERVICE_NAME: &str = "playground";

/// Mutable state shared between `wait_for_services` and
/// `extend_wait_deadline`. The deadline is stored as nanos-from-
/// start so consumers can compare against `wait_started.elapsed()`
/// rather than passing tokio Instants across the Tauri command
/// boundary (Instants don't serialize).
#[derive(Default)]
pub struct WaitDeadlineState {
    inner: Mutex<Option<WaitDeadline>>,
}

/// Per-wait deadline + supersede + extend-notify handles. Cloned
/// when handed out so multiple owners can observe the same atomics.
struct WaitDeadline {
    start: Instant,
    deadline_nanos: Arc<AtomicI64>,
    extensions_used: Arc<AtomicU32>,
    /// Pinged by `extend_wait_deadline` so a wait parked past the
    /// hard deadline can resume promptly.
    extend_notify: Arc<Notify>,
    /// Flipped to `true` by `install()` when a new wait supersedes
    /// this one. The loop polls it via the same `extend_notify`
    /// (so a single ping wakes both extension AND supersede).
    cancelled: Arc<AtomicBool>,
}

impl WaitDeadline {
    fn clone_handle(&self) -> Self {
        Self {
            start: self.start,
            deadline_nanos: self.deadline_nanos.clone(),
            extensions_used: self.extensions_used.clone(),
            extend_notify: self.extend_notify.clone(),
            cancelled: self.cancelled.clone(),
        }
    }

    fn nanos_remaining(&self) -> i64 {
        let elapsed = i64::try_from(self.start.elapsed().as_nanos()).unwrap_or(i64::MAX);
        self.deadline_nanos
            .load(Ordering::Acquire)
            .saturating_sub(elapsed)
    }
}

impl WaitDeadlineState {
    /// Returns a clone of the active wait's handles, if any. Used
    /// by `extend_wait_deadline` to push the deadline out.
    async fn current(&self) -> Option<WaitDeadline> {
        self.inner.lock().await.as_ref().map(|d| d.clone_handle())
    }

    /// Installs a fresh deadline at `hard_secs` from now. Cancels
    /// any prior wait by flipping its `cancelled` flag and pinging
    /// its `extend_notify` — the prior loop sees the flag, exits
    /// cleanly, and stops contending for the deadline atomic.
    async fn install(&self, hard_secs: u64) -> WaitDeadline {
        let deadline_nanos =
            i64::try_from(u128::from(hard_secs) * 1_000_000_000_u128).unwrap_or(i64::MAX);
        let deadline = WaitDeadline {
            start: Instant::now(),
            deadline_nanos: Arc::new(AtomicI64::new(deadline_nanos)),
            extensions_used: Arc::new(AtomicU32::new(0)),
            extend_notify: Arc::new(Notify::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let snapshot = deadline.clone_handle();
        let mut slot = self.inner.lock().await;
        if let Some(prior) = slot.take() {
            prior.cancelled.store(true, Ordering::Release);
            prior.extend_notify.notify_waiters();
        }
        *slot = Some(deadline);
        snapshot
    }

    /// Clears the active wait — call when the loop exits cleanly
    /// (all-healthy, timeout-cap, unreachable, or shutting-down).
    async fn clear(&self) {
        *self.inner.lock().await = None;
    }
}

/// Test-only override for the launcher health URL. Production reads
/// the const above; tests installing an httptest::Server can flip
/// this to point at the test server's address. Same shape as
/// `healthServerAddrOverride` in tools/friday-launcher/uninstall.go.
fn launcher_health_url() -> String {
    if let Ok(s) = std::env::var("FRIDAY_LAUNCHER_HEALTH_URL_OVERRIDE") {
        if !s.is_empty() {
            return s;
        }
    }
    LAUNCHER_HEALTH_URL.to_string()
}

/// Pure helper extracted for testability — deadline gate the
/// SSE-connect retry loop reads. A regression to `>` instead of
/// `>=` would extend the loop one cycle past the budget; pinning
/// this in a unit test catches that.
fn should_give_up(now: Instant, deadline: Instant) -> bool {
    now >= deadline
}

/// Pure helper extracted for testability — capped doubling backoff.
/// `next_backoff_ms(d)` returns the next sleep duration; capped at
/// `SSE_BACKOFF_MAX_MS`.
fn next_backoff_ms(current_ms: u64) -> u64 {
    current_ms.saturating_mul(2).min(SSE_BACKOFF_MAX_MS)
}

/// Connect to the launcher's SSE endpoint with capped exponential
/// backoff. Returns the live response stream once connected, or an
/// error if the deadline elapses without a successful connect.
async fn connect_with_backoff(client: &reqwest::Client) -> Result<reqwest::Response, String> {
    let url = launcher_health_url();
    let mut delay_ms = SSE_BACKOFF_INITIAL_MS;
    let deadline = Instant::now() + SSE_CONNECT_DEADLINE;
    let mut last_err: String;
    loop {
        match client
            .get(&url)
            .header("Accept", "text/event-stream")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                last_err = format!("HTTP {} from launcher", resp.status());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
        if should_give_up(Instant::now(), deadline) {
            return Err(format!(
                "launcher unreachable after {}s: {}",
                SSE_CONNECT_DEADLINE.as_secs(),
                last_err
            ));
        }
        sleep(Duration::from_millis(delay_ms)).await;
        delay_ms = next_backoff_ms(delay_ms);
    }
}

/// Parse one or more SSE `data: <json>\n\n` records from a buffer.
/// Returns the consumed prefix length and the parsed payloads, in
/// order. Anything before the last terminator stays in the buffer
/// for the next read.
///
/// SSE is line-oriented; a single event ends with a blank line.
/// We only care about `data:` lines (the launcher doesn't emit
/// event names, ids, or retries).
fn parse_sse_chunks(buf: &str) -> (usize, Vec<String>) {
    let mut payloads = Vec::new();
    let mut current = String::new();
    let mut last_terminator_end = 0usize;
    let mut idx = 0usize;
    while let Some(end) = buf[idx..].find('\n') {
        let line_end = idx + end;
        let raw_line = &buf[idx..line_end];
        // Strip trailing \r if present.
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            // Blank line — event terminator.
            if !current.is_empty() {
                payloads.push(std::mem::take(&mut current));
            }
            last_terminator_end = line_end + 1;
        } else if let Some(data) = line.strip_prefix("data: ") {
            current.push_str(data);
        } else if let Some(data) = line.strip_prefix("data:") {
            current.push_str(data);
        }
        idx = line_end + 1;
    }
    (last_terminator_end, payloads)
}

/// Build a `Timeout` event from the most-recent observed snapshot.
/// `stuck` is every service whose status isn't "healthy";
/// `playground_healthy` drives the partial-success rule. If we
/// never observed a snapshot (no SSE events arrived in the wait
/// window — extreme), the timeout event is empty + non-healthy
/// playground, which makes the frontend hide "Open anyway" and
/// just show View logs / Wait again.
fn timeout_event_from_snapshot(latest: Option<&HealthSnapshot>) -> HealthEvent {
    let Some(snap) = latest else {
        return HealthEvent::Timeout {
            stuck: Vec::new(),
            playground_healthy: false,
        };
    };
    let stuck: Vec<String> = snap
        .services
        .iter()
        .filter(|s| s.status != "healthy")
        .map(|s| s.name.clone())
        .collect();
    let playground_healthy = snap
        .services
        .iter()
        .any(|s| s.name == PLAYGROUND_SERVICE_NAME && s.status == "healthy");
    HealthEvent::Timeout {
        stuck,
        playground_healthy,
    }
}

/// Wait for the launcher's services to all report healthy. Sends
/// `HealthEvent`s through the supplied Channel; returns when the
/// stream ends (all-healthy, unreachable, EOF, or supersede).
///
/// Past the hard deadline the loop emits `Timeout` ONCE and then
/// parks on the deadline's `extend_notify`. A subsequent
/// `extend_wait_deadline` Tauri command pushes the deadline out
/// AND pings the notify; the loop wakes, re-checks the deadline,
/// and resumes streaming. A new `wait_for_services` invocation
/// supersedes the parked loop (via `cancelled`) so the wizard can
/// safely re-enter the Launch step.
#[tauri::command]
pub async fn wait_for_services(
    on_event: Channel<HealthEvent>,
    deadline_state: State<'_, WaitDeadlineState>,
) -> Result<(), String> {
    // Send Connecting before the (potentially long) backoff loop so
    // the frontend has something to render.
    let _ = on_event.send(HealthEvent::Connecting);

    let client = reqwest::Client::builder()
        // No connection pool for SSE — each request opens a fresh
        // long-lived stream. Disable timeouts globally; we enforce
        // the 20s connect deadline ourselves, and the SSE stream
        // is meant to live indefinitely once connected.
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;

    let resp = match connect_with_backoff(&client).await {
        Ok(r) => r,
        Err(reason) => {
            let _ = on_event.send(HealthEvent::Unreachable { reason });
            return Ok(());
        }
    };

    let _ = on_event.send(HealthEvent::Connected);

    // Install the wait deadline now that SSE is live. Soft and hard
    // are independent: the soft fires once at +60s; the hard is the
    // deadline_nanos atomic the frontend can extend.
    let deadline = deadline_state.install(HARD_DEADLINE_SECS).await;
    let mut soft_fired = false;
    let mut timeout_fired = false;
    // Track the most-recent snapshot so the timeout event can
    // populate `stuck` + `playground_healthy` honestly.
    let mut latest_snapshot: Option<HealthSnapshot> = None;

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    loop {
        // A supersede from a re-entered wizard wins over everything —
        // exit silently so the new wait owns the user-visible state.
        if deadline.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }

        // Soft deadline fires once at +60s. After it fires, the wait
        // continues — frontend handles the UI swap.
        if !soft_fired && deadline.start.elapsed().as_secs() >= SOFT_DEADLINE_SECS {
            soft_fired = true;
            let _ = on_event.send(HealthEvent::SoftDeadline);
        }

        let remaining_nanos = deadline.nanos_remaining();
        if remaining_nanos <= 0 {
            // Hard deadline elapsed.
            //   - First time: emit Timeout (with the real stuck
            //     list and playground status) and park on the
            //     extend_notify; resuming on extension or supersede.
            //   - If the cap is reached and no further extension
            //     can come: the frontend stops calling extend, the
            //     loop sits parked indefinitely, and a wizard re-
            //     entry supersedes via `cancelled`.
            if !timeout_fired {
                timeout_fired = true;
                let _ = on_event.send(timeout_event_from_snapshot(latest_snapshot.as_ref()));
            }
            // Park until extension or supersede pings the notify.
            // STREAM_POLL_CAP is the recovery ceiling for either:
            //   - a cancelled flip whose notify is missed (loop
            //     between iterations when install() ran), or
            //   - an extension whose notify is missed (same gap).
            // Self-healing: ≤1s before the next loop sees the
            // updated atomic. Same defense applies to the streaming-
            // branch select below.
            tokio::select! {
                _ = deadline.extend_notify.notified() => {},
                _ = sleep(STREAM_POLL_CAP) => {},
            }
            continue;
        }

        // Reaching here means we re-checked `nanos_remaining` and
        // it's > 0. If a prior iteration emitted Timeout, an
        // extension has since pushed the deadline forward — reset
        // the latch so a future re-elapse fires a FRESH Timeout
        // event. Without this reset, a wizard that hits the cap
        // (210s) after two extensions would see the loop park
        // indefinitely while the frontend stays in long-wait with
        // no escape (canExtendDeadline=false; View logs is only
        // shown in the timeout state). See should_reset_timeout_latch
        // for the unit-tested rule.
        if should_reset_timeout_latch(timeout_fired, remaining_nanos) {
            timeout_fired = false;
        }

        // Below the hard deadline: read the next SSE chunk with a
        // bounded poll so we re-check the deadline (and cancel flag)
        // promptly even if the launcher goes silent.
        let bound = u64::try_from(remaining_nanos).unwrap_or(0);
        let chunk_timeout = Duration::from_nanos(bound).min(STREAM_POLL_CAP);
        let chunk = tokio::select! {
            biased;
            _ = deadline.extend_notify.notified() => {
                // Extension landed — loop, deadline atomic was
                // updated by extend_wait_deadline before the ping.
                continue;
            }
            r = tokio::time::timeout(chunk_timeout, stream.next()) => r,
        };
        let bytes = match chunk {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => {
                // Stream error mid-flight — surface as Unreachable
                // so the frontend shows View logs.
                let _ = on_event.send(HealthEvent::Unreachable {
                    reason: format!("stream error: {e}"),
                });
                deadline_state.clear().await;
                return Ok(());
            }
            Ok(None) => {
                // Stream closed unexpectedly. EOF doesn't distinguish
                // orderly shutdown (which the launcher signals via a
                // snapshot with shutting_down: true BEFORE closing)
                // from a launcher crash, network drop, or OS resource
                // exhaustion. Treat as Unreachable; the snapshot path
                // above is what handles the orderly case.
                let _ = on_event.send(HealthEvent::Unreachable {
                    reason: "stream closed unexpectedly".to_string(),
                });
                deadline_state.clear().await;
                return Ok(());
            }
            Err(_) => {
                // Read timeout — loop back, re-check deadline +
                // cancel flag. Common path when the launcher
                // hasn't transitioned any service this tick.
                continue;
            }
        };

        // Append the chunk to the rolling buffer and parse out any
        // complete SSE events.
        buf.push_str(&String::from_utf8_lossy(&bytes));
        let (consumed, payloads) = parse_sse_chunks(&buf);
        if consumed > 0 {
            buf.drain(..consumed);
        }

        for payload in payloads {
            let snap = match serde_json::from_str::<HealthSnapshot>(&payload) {
                Ok(s) => s,
                Err(_) => {
                    // Malformed payload — log + continue. We don't
                    // surface this as a UI event because it could be
                    // a transient framing issue.
                    continue;
                }
            };
            let all_healthy = snap.all_healthy;
            let shutting_down = snap.shutting_down;
            // Forward + retain. The frontend overwrites store.services
            // wholesale per Snapshot event, so retaining a clone here
            // is the only way to populate the timeout payload faithfully.
            latest_snapshot = Some(snap.clone());
            let _ = on_event.send(HealthEvent::Snapshot(snap));
            if shutting_down {
                let _ = on_event.send(HealthEvent::ShuttingDown);
                deadline_state.clear().await;
                return Ok(());
            }
            if all_healthy {
                deadline_state.clear().await;
                return Ok(());
            }
        }
    }
}

/// Shared CAS+arithmetic body for `extend_wait_deadline`. Tests call
/// this directly so they exercise exactly what the production
/// command does — no mirror-or-die contract. The Tauri command
/// itself is a 2-line wrapper around this.
///
/// CAS via fetch_update so two concurrent calls can't both observe
/// `prior < MAX` and both push the deadline. Without this guard, a
/// race would let the cap be bypassed (counter=1 but deadline_nanos
/// pushed by 2 * EXTENSION_SECS). Tauri command dispatch is async;
/// even if the wizard's button is single-source, a future autoclick
/// / keyboard repeat / test harness could trigger the race.
async fn do_extend_wait_deadline(
    deadline_state: &WaitDeadlineState,
) -> Result<Option<u64>, String> {
    let Some(deadline) = deadline_state.current().await else {
        return Ok(None);
    };
    if deadline
        .extensions_used
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            if n >= MAX_EXTENSIONS {
                None
            } else {
                Some(n + 1)
            }
        })
        .is_err()
    {
        return Ok(None);
    }
    let added_nanos =
        i64::try_from(u128::from(EXTENSION_SECS) * 1_000_000_000_u128).unwrap_or(i64::MAX);
    let new_nanos = deadline
        .deadline_nanos
        .fetch_add(added_nanos, Ordering::AcqRel)
        + added_nanos;
    // Wake any parked wait loop so it sees the new deadline.
    deadline.extend_notify.notify_waiters();
    let new_secs = u64::try_from(new_nanos / 1_000_000_000).unwrap_or(0);
    Ok(Some(new_secs))
}

/// Push the wait deadline out by `EXTENSION_SECS`. Capped at
/// `MAX_EXTENSIONS` total. Returns the new deadline (seconds from
/// wait start) so the frontend can render an accurate "wait again"
/// affordance, or `None` if the cap is reached or no wait is active.
///
/// Pings the wait loop's `extend_notify` so a parked timeout wakes
/// promptly — without it the loop would sit on its STREAM_POLL_CAP
/// sleep before noticing the deadline atomic moved. Body lives in
/// `do_extend_wait_deadline` so tests can drive the same logic
/// without a Tauri State<> wrapper.
#[tauri::command]
pub async fn extend_wait_deadline(
    deadline_state: State<'_, WaitDeadlineState>,
) -> Result<Option<u64>, String> {
    do_extend_wait_deadline(&deadline_state).await
}

/// Pure helper extracted for testability — answers "should we reset
/// the timeout-fired latch?" given the current loop state. The reset
/// is the cycle-2 fix that prevents the wait loop from stranding the
/// UI in long-wait after the second 60s extension elapses without
/// all-healthy. A regression dropping the reset re-introduces the
/// 210s deadlock with no test failure unless this helper is pinned.
fn should_reset_timeout_latch(timeout_fired: bool, remaining_nanos: i64) -> bool {
    timeout_fired && remaining_nanos > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── SSE parser ─────────────────────────────────────────────

    #[test]
    fn parse_sse_single_event() {
        let buf = "data: {\"a\":1}\n\n";
        let (consumed, payloads) = parse_sse_chunks(buf);
        assert_eq!(consumed, buf.len());
        assert_eq!(payloads, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn parse_sse_multiple_events() {
        let buf = "data: a\n\ndata: b\n\n";
        let (consumed, payloads) = parse_sse_chunks(buf);
        assert_eq!(consumed, buf.len());
        assert_eq!(payloads, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn parse_sse_partial_event_left_in_buffer() {
        let buf = "data: a\n\ndata: b\n";
        let (consumed, payloads) = parse_sse_chunks(buf);
        assert_eq!(consumed, "data: a\n\n".len());
        assert_eq!(payloads, vec!["a".to_string()]);
    }

    #[test]
    fn parse_sse_handles_crlf() {
        let buf = "data: a\r\n\r\n";
        let (_, payloads) = parse_sse_chunks(buf);
        assert_eq!(payloads, vec!["a".to_string()]);
    }

    #[test]
    fn parse_sse_handles_no_space_after_colon() {
        let buf = "data:hello\n\n";
        let (_, payloads) = parse_sse_chunks(buf);
        assert_eq!(payloads, vec!["hello".to_string()]);
    }

    // ── Backoff helpers ────────────────────────────────────────

    #[test]
    fn backoff_doubles_until_cap() {
        // 200 → 400 → 800 → 1600 → 2000 (capped) → 2000
        assert_eq!(next_backoff_ms(200), 400);
        assert_eq!(next_backoff_ms(400), 800);
        assert_eq!(next_backoff_ms(800), 1600);
        assert_eq!(next_backoff_ms(1600), SSE_BACKOFF_MAX_MS);
        assert_eq!(next_backoff_ms(SSE_BACKOFF_MAX_MS), SSE_BACKOFF_MAX_MS);
    }

    #[test]
    fn backoff_handles_overflow_via_saturation() {
        // saturating_mul keeps next_backoff_ms total under SSE_BACKOFF_MAX_MS
        // even on a misbehaving u64.
        assert_eq!(next_backoff_ms(u64::MAX / 4), SSE_BACKOFF_MAX_MS);
    }

    #[test]
    fn give_up_is_inclusive() {
        // Off-by-one regression: should_give_up MUST trigger at
        // exactly the deadline, not one tick past it. Otherwise
        // the SSE-connect loop runs `next_backoff_ms` extra time
        // before honoring the budget.
        let now = Instant::now();
        let deadline = now;
        assert!(should_give_up(now, deadline));
        // And not before:
        let before = now.checked_sub(Duration::from_millis(1)).unwrap_or(now);
        assert!(!should_give_up(before, deadline));
    }

    // ── Timeout event from snapshot ────────────────────────────

    fn svc(name: &str, status: &str) -> ServiceStatus {
        ServiceStatus {
            name: name.to_string(),
            status: status.to_string(),
            since_secs: 0,
        }
    }

    fn snap(services: Vec<ServiceStatus>) -> HealthSnapshot {
        HealthSnapshot {
            uptime_secs: 0,
            services,
            all_healthy: false,
            shutting_down: false,
        }
    }

    #[test]
    fn timeout_event_lists_unhealthy_services_only() {
        let s = snap(vec![
            svc("nats-server", "healthy"),
            svc("friday", "starting"),
            svc("playground", "starting"),
        ]);
        let HealthEvent::Timeout {
            stuck,
            playground_healthy,
        } = timeout_event_from_snapshot(Some(&s))
        else {
            panic!("expected Timeout variant");
        };
        assert_eq!(stuck, vec!["friday".to_string(), "playground".to_string()]);
        assert!(!playground_healthy);
    }

    #[test]
    fn timeout_event_sets_playground_healthy_when_playground_green() {
        let s = snap(vec![
            svc("playground", "healthy"),
            svc("webhook-tunnel", "starting"),
        ]);
        let HealthEvent::Timeout {
            stuck,
            playground_healthy,
        } = timeout_event_from_snapshot(Some(&s))
        else {
            panic!("expected Timeout variant");
        };
        assert_eq!(stuck, vec!["webhook-tunnel".to_string()]);
        assert!(playground_healthy);
    }

    #[test]
    fn timeout_event_no_snapshot_yields_empty_payload() {
        let HealthEvent::Timeout {
            stuck,
            playground_healthy,
        } = timeout_event_from_snapshot(None)
        else {
            panic!("expected Timeout variant");
        };
        assert!(stuck.is_empty());
        assert!(!playground_healthy);
    }

    // ── WaitDeadlineState extension cap ────────────────────────

    /// Helper that mirrors the extend_wait_deadline command body
    #[tokio::test]
    async fn extension_cap_pins_at_two() {
        // Drives the production command body (do_extend_wait_deadline)
        // directly — no test-only helper that could drift from the
        // command. A regression in the cap arithmetic or the CAS
        // gate fails this test. Pinning the cap protects the v15
        // plan's 210s ceiling against a future drop of the gate.
        let state = WaitDeadlineState::default();
        let _ = state.install(HARD_DEADLINE_SECS).await;

        // First extension: 90 + 60 = 150.
        let r1 = do_extend_wait_deadline(&state).await.unwrap();
        assert_eq!(r1, Some(150));

        // Second extension: 150 + 60 = 210.
        let r2 = do_extend_wait_deadline(&state).await.unwrap();
        assert_eq!(r2, Some(210));

        // Third extension: capped.
        let r3 = do_extend_wait_deadline(&state).await.unwrap();
        assert_eq!(r3, None);

        // Atomic-level sanity: counter must equal MAX_EXTENSIONS.
        let d = state.current().await.expect("wait should still be active");
        let prior_3 = d.extensions_used.load(Ordering::Acquire);
        assert!(
            prior_3 >= MAX_EXTENSIONS,
            "third extension must be rejected by the cap; got prior_3={prior_3}"
        );
    }

    #[tokio::test]
    async fn install_supersedes_prior_wait() {
        // Two consecutive `install` calls — the first must be
        // marked cancelled. A regression that drops the cancel
        // ping would let two SSE loops run in parallel, each
        // extending its own deadline atomic, with the wizard's
        // extend_wait_deadline call only addressing the latest.
        let state = WaitDeadlineState::default();
        let first = state.install(HARD_DEADLINE_SECS).await;
        assert!(!first.cancelled.load(Ordering::Acquire));
        let _second = state.install(HARD_DEADLINE_SECS).await;
        assert!(
            first.cancelled.load(Ordering::Acquire),
            "first wait must be cancelled after a second install"
        );
    }

    #[tokio::test]
    async fn extension_cap_holds_at_boundary() {
        // Pins the cap arithmetic at the boundary: with the counter
        // at MAX-1, two consecutive extensions yield exactly one
        // success (Some(210)) and one None, with deadline_nanos
        // landing at 210s (90+60+60), not 270s.
        //
        // NOTE: this test does NOT genuinely race load-then-store
        // versus CAS — `do_extend_wait_deadline` has zero `.await`
        // points between the `current()` lookup and the
        // `fetch_update`, so two `tokio::spawn`s cannot interleave
        // between load and store regardless of runtime flavor.
        // The CAS atomicity is correct by code inspection (the
        // `fetch_update` closure is the standard pattern). What
        // this test pins is the cap arithmetic at the boundary —
        // a regression that drops the cap gate (Some/None branch
        // in the closure) would still fail this test cleanly.
        let state = WaitDeadlineState::default();
        let _ = state.install(HARD_DEADLINE_SECS).await;
        let r1 = do_extend_wait_deadline(&state).await.unwrap();
        assert_eq!(r1, Some(150));

        let s = std::sync::Arc::new(state);
        let s1 = s.clone();
        let s2 = s.clone();
        let h1 = tokio::spawn(async move { do_extend_wait_deadline(&s1).await });
        let h2 = tokio::spawn(async move { do_extend_wait_deadline(&s2).await });
        let r1 = h1.await.unwrap().unwrap();
        let r2 = h2.await.unwrap().unwrap();
        let mut results = vec![r1, r2];
        results.sort();
        assert_eq!(
            results,
            vec![None, Some(210)],
            "exactly one extension at the boundary must succeed; got {results:?}"
        );

        // And the deadline_nanos must reflect exactly two extensions
        // beyond the original HARD_DEADLINE_SECS (90 + 60 + 60 =
        // 210s). A regression that pushed twice would land at 270s.
        let d = s.current().await.expect("wait should still be active");
        let nanos = d.deadline_nanos.load(Ordering::Acquire);
        let secs = nanos / 1_000_000_000;
        assert_eq!(
            secs, 210,
            "deadline must equal 90+60+60=210s; got {secs}s (cap bypassed?)"
        );
    }

    // ── Timeout-fired latch reset (cycle-2 fix) ────────────────

    #[test]
    fn latch_reset_no_op_when_never_fired() {
        // Reset should be a no-op on the never-fired path: latch
        // is false at loop entry; reset stays false. Catches a
        // regression that toggles instead of conditionally clears.
        assert!(!should_reset_timeout_latch(false, 0));
        assert!(!should_reset_timeout_latch(false, 1_000_000_000));
        assert!(!should_reset_timeout_latch(false, -1));
    }

    #[test]
    fn latch_reset_holds_when_remaining_is_zero_or_negative() {
        // Latch must persist while the deadline is still elapsed —
        // we're still past the hard deadline, the loop should
        // remain in parked-Timeout mode without re-firing.
        assert!(!should_reset_timeout_latch(true, 0));
        assert!(!should_reset_timeout_latch(true, -1));
        assert!(!should_reset_timeout_latch(true, i64::MIN));
    }

    #[test]
    fn latch_reset_fires_when_extension_pushed_remaining_positive() {
        // Latch must reset only when an extension landed (deadline
        // pushed forward, remaining > 0). This is the cycle-2 fix:
        // without it the wait loop strands the UI in long-wait
        // after the second 60s extension elapses without all-
        // healthy at 210s.
        assert!(should_reset_timeout_latch(true, 1));
        assert!(should_reset_timeout_latch(true, 60_000_000_000));
        assert!(should_reset_timeout_latch(true, i64::MAX));
    }
}
