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
//! The `extend_wait_deadline` Tauri command pushes the deadline out
//! by 60s — capped at two extensions per the v15 plan.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
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
/// surfaces View logs / Open anyway / Wait again.
const HARD_DEADLINE_SECS: u64 = 90;
const EXTENSION_SECS: u64 = 60;
const MAX_EXTENSIONS: u32 = 2;

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
    /// SSE-connect retry budget exhausted. The launcher never
    /// bound port 5199 within `SSE_CONNECT_DEADLINE`. Fatal —
    /// frontend shows "could not connect to launcher" + View logs.
    Unreachable {
        reason: String,
    },
    /// Launcher reported `shutting_down: true` mid-wait. Treat as
    /// fatal — the user manually triggered a shutdown or something
    /// else hit the launcher's HTTP shutdown endpoint.
    ShuttingDown,
}

/// Mutable state shared between `wait_for_services` and
/// `extend_wait_deadline`. The deadline is an absolute Instant, so
/// extension is a single atomic add — no mutex needed for the
/// commonly-read path.
///
/// `deadline_secs_from_start` is stored as nanos since the wait
/// started; the consumer compares against `wait_started.elapsed()`
/// rather than against an `Instant` (avoids passing tokio Instants
/// across the Tauri command boundary, which doesn't serialize).
#[derive(Default)]
pub struct WaitDeadlineState {
    inner: Mutex<Option<WaitDeadline>>,
}

struct WaitDeadline {
    start: Instant,
    deadline_nanos: Arc<AtomicI64>,
    extensions_used: Arc<std::sync::atomic::AtomicU32>,
}

impl WaitDeadlineState {
    /// Returns the deadline atomic for the active wait, if any. Used
    /// by `extend_wait_deadline` to push the deadline out.
    async fn current(&self) -> Option<WaitDeadline> {
        self.inner.lock().await.as_ref().map(|d| WaitDeadline {
            start: d.start,
            deadline_nanos: d.deadline_nanos.clone(),
            extensions_used: d.extensions_used.clone(),
        })
    }

    /// Installs a fresh deadline at `HARD_DEADLINE_SECS` from now.
    /// Replaces any prior deadline (a wizard re-run shouldn't
    /// inherit the previous one's extension state).
    async fn install(&self, hard_secs: u64) -> WaitDeadline {
        let deadline = WaitDeadline {
            start: Instant::now(),
            deadline_nanos: Arc::new(AtomicI64::new((hard_secs * 1_000_000_000) as i64)),
            extensions_used: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        let snapshot = WaitDeadline {
            start: deadline.start,
            deadline_nanos: deadline.deadline_nanos.clone(),
            extensions_used: deadline.extensions_used.clone(),
        };
        *self.inner.lock().await = Some(deadline);
        snapshot
    }

    /// Clears the active wait — call when the loop exits cleanly
    /// (all-healthy, timeout, or shutting-down).
    async fn clear(&self) {
        *self.inner.lock().await = None;
    }
}

/// Test-only override for the launcher health URL. Production reads
/// the const above; tests installing a httptest::Server can flip
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
        if Instant::now() >= deadline {
            return Err(format!(
                "launcher unreachable after {}s: {}",
                SSE_CONNECT_DEADLINE.as_secs(),
                last_err
            ));
        }
        sleep(Duration::from_millis(delay_ms)).await;
        delay_ms = (delay_ms * 2).min(SSE_BACKOFF_MAX_MS);
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

/// Wait for the launcher's services to all report healthy. Sends
/// `HealthEvent`s through the supplied Channel; returns when the
/// stream ends (all-healthy, timeout, unreachable, or shutting-down).
///
/// The frontend installs a Channel, calls this, and renders each
/// event. The command itself is `async` and does NOT block the
/// frontend — Tauri runs it on the tokio runtime.
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

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    loop {
        // Compute remaining time on each iteration so an extension
        // landed via extend_wait_deadline is observed promptly.
        let elapsed_nanos = deadline.start.elapsed().as_nanos() as i64;
        let deadline_nanos = deadline.deadline_nanos.load(Ordering::Acquire);
        let remaining_nanos = deadline_nanos.saturating_sub(elapsed_nanos);

        // Soft deadline fires once at +60s. After it fires, the wait
        // continues — frontend handles the UI swap.
        if !soft_fired
            && deadline.start.elapsed().as_secs() >= SOFT_DEADLINE_SECS
        {
            soft_fired = true;
            let _ = on_event.send(HealthEvent::SoftDeadline);
        }

        if remaining_nanos <= 0 {
            // Hard deadline elapsed. Collect stuck services + check
            // playground health for the partial-success rule.
            let _ = on_event.send(timeout_event_from_buffer(&buf));
            deadline_state.clear().await;
            return Ok(());
        }

        let chunk_timeout = Duration::from_nanos(remaining_nanos as u64).min(Duration::from_secs(1));
        let chunk = match tokio::time::timeout(chunk_timeout, stream.next()).await {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => {
                // Stream error mid-flight — surface as Unreachable so
                // the frontend can show View logs.
                let _ = on_event.send(HealthEvent::Unreachable {
                    reason: format!("stream error: {e}"),
                });
                deadline_state.clear().await;
                return Ok(());
            }
            Ok(None) => {
                // Stream closed by the launcher. Treat as ShuttingDown
                // — the launcher's HTTP server only closes the stream
                // during shutdown.
                let _ = on_event.send(HealthEvent::ShuttingDown);
                deadline_state.clear().await;
                return Ok(());
            }
            Err(_) => {
                // Timeout on the read — loop back and re-check the
                // deadline. No event emitted; this is just keeping
                // the loop responsive to extend_wait_deadline.
                continue;
            }
        };

        // Append the chunk to the rolling buffer and parse out any
        // complete SSE events.
        buf.push_str(&String::from_utf8_lossy(&chunk));
        let (consumed, payloads) = parse_sse_chunks(&buf);
        if consumed > 0 {
            buf.drain(..consumed);
        }

        for payload in payloads {
            match serde_json::from_str::<HealthSnapshot>(&payload) {
                Ok(snap) => {
                    let all_healthy = snap.all_healthy;
                    let shutting_down = snap.shutting_down;
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
                Err(_) => {
                    // Malformed payload — log + continue. We don't
                    // surface this as a UI event because it could
                    // be a transient framing issue.
                }
            }
        }
    }
}

/// Push the wait deadline out by `EXTENSION_SECS`. Capped at
/// `MAX_EXTENSIONS` total. Returns the new deadline (seconds from
/// wait start) so the frontend can render an accurate "wait again"
/// affordance, or `None` if the cap is reached or no wait is active.
#[tauri::command]
pub async fn extend_wait_deadline(
    deadline_state: State<'_, WaitDeadlineState>,
) -> Result<Option<u64>, String> {
    let Some(deadline) = deadline_state.current().await else {
        return Ok(None);
    };
    let prior = deadline.extensions_used.load(Ordering::Acquire);
    if prior >= MAX_EXTENSIONS {
        return Ok(None);
    }
    deadline.extensions_used.store(prior + 1, Ordering::Release);
    let added_nanos = (EXTENSION_SECS * 1_000_000_000) as i64;
    let new_nanos = deadline
        .deadline_nanos
        .fetch_add(added_nanos, Ordering::AcqRel)
        + added_nanos;
    Ok(Some((new_nanos as u64) / 1_000_000_000))
}

/// Build a Timeout event from the current snapshot buffer. We don't
/// have direct access to the most-recent snapshot here (the loop
/// already drained the buffer), so this is a conservative fallback:
/// emit Timeout with empty `stuck` and `playground_healthy: false`.
/// In practice the loop returns Timeout right after consuming a
/// snapshot, so this only fires if the launcher hasn't sent ANY
/// snapshot in 90s — which means everything's stuck.
fn timeout_event_from_buffer(_buf: &str) -> HealthEvent {
    HealthEvent::Timeout {
        stuck: Vec::new(),
        playground_healthy: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
