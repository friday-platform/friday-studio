// stop_running_launcher — orderly-shutdown a previous-version launcher
// before the wizard's Launch step spawns a fresh one.
//
// Reason this exists:
//   The wizard happily re-runs through download → extract → launch
//   even when an older launcher is still alive. Two failure modes:
//     1. Port 5199 collision: the new launcher's bind fails, the
//        port-in-use dialog fires, and the user has to pkill manually.
//     2. The old supervised processes (friday, nats, etc.) are still
//        running on their ports; the new launcher's children can't
//        bind, restart-loop, eventually die.
//
// The launcher exposes POST /api/launcher-shutdown specifically for
// this case (Decision #9 + #10 + Stack 1). It returns 202/409 in
// microseconds and triggers an orderly shutdown — the same one
// `--uninstall` and the tray Quit drive. We wait for the launcher's
// PID to exit (up to `LAUNCHER_EXIT_TIMEOUT`) so the wizard can move
// on with confidence that port 5199 is free.
//
// Caller-side response handling matches the v15 § Caller table:
//   - connection refused / EOF → no launcher running, return Ok early
//   - 202 / 409                → poll for exit
//   - everything else          → bubble up as Err so the UI can show it

use std::time::{Duration, Instant};

const LAUNCHER_HEALTH_ADDR: &str = "127.0.0.1:5199";
const SHUTDOWN_HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const LAUNCHER_EXIT_TIMEOUT: Duration = Duration::from_secs(35);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[tauri::command]
pub async fn stop_running_launcher() -> Result<bool, String> {
    // 1. Probe — if 5199 isn't bound, there's nothing to stop. Skip.
    if !port_is_bound(LAUNCHER_HEALTH_ADDR).await {
        return Ok(false);
    }

    // 2. Issue the shutdown request. Treat connection refused as
    //    "already gone" — race between probe and POST.
    let url = format!("http://{LAUNCHER_HEALTH_ADDR}/api/launcher-shutdown");
    let client = reqwest::Client::builder()
        .timeout(SHUTDOWN_HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;
    let resp = match client.post(&url).send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            // Connection refused / timeout → the launcher already
            // exited between the probe and the POST. Verify and
            // declare success.
            return Ok(!port_is_bound(LAUNCHER_HEALTH_ADDR).await);
        }
        Err(e) => return Err(format!("POST shutdown: {e}")),
    };
    let status = resp.status();
    if !(status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::CONFLICT) {
        return Err(format!("shutdown returned {status}"));
    }

    // 3. Wait for the port to free. Polling 5199 is more reliable
    //    than reading the launcher.pid file (which the launcher
    //    only removes after a clean shutdown — a SIGKILL'd process
    //    leaves it stale).
    let deadline = Instant::now() + LAUNCHER_EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if !port_is_bound(LAUNCHER_HEALTH_ADDR).await {
            return Ok(true);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err(format!(
        "launcher did not exit within {}s after shutdown request",
        LAUNCHER_EXIT_TIMEOUT.as_secs()
    ))
}

async fn port_is_bound(addr: &str) -> bool {
    // A connect attempt to a bound socket succeeds; on an unbound
    // port the OS replies ECONNREFUSED almost immediately. 500ms
    // is plenty even on a loaded machine.
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(addr),
        )
        .await,
        Ok(Ok(_))
    )
}
