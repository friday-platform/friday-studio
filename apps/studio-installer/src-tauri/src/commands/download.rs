use futures_util::StreamExt;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress {
        downloaded: u64,
        total: u64,
        bytes_per_sec: u64,
    },
    Retrying {
        attempt: u32,
        max_attempts: u32,
        delay_secs: u64,
        error: String,
    },
    Done,
    Error {
        message: String,
    },
}

// Throttle progress events to ~2/sec — at multi-MB/s download speeds the
// per-chunk report rate produced 100+ events/sec, so the speed/ETA labels
// flickered too fast for the user to read. The progress bar still updates
// smoothly because every event includes the absolute downloaded byte count.
const PROGRESS_INTERVAL_MS: u128 = 500;
const MAX_RETRIES: u32 = 5;

// Idle timeout per chunk read. Cloudflare's HTTP/2 framing has been
// observed to keep the stream open after delivering all bytes (no
// END_STREAM flag) AND to occasionally deliver content_length-1 bytes
// then idle, which left stream.next().await pending indefinitely:
// download_file never returned, JS `await invoke` never resolved, the
// wizard sat at "100% · ETA 0s" forever. 30s is well above any realistic
// chunk gap on a working connection; if no bytes arrive in that window
// we treat the stream as stalled and surface as a retryable error.
const CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

// Hard cap on the entire download. 10 min is enough to pull 1.5 GB on
// the slowest broadband we'd ship to. If a single attempt is still
// running past that, something is wrong (DNS flapping, server stuck on
// transfer-encoding chunked, etc.) and the retry path is more useful
// than waiting longer.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(600);

#[tauri::command]
pub async fn download_file(
    url: String,
    dest: String,
    on_progress: Channel<DownloadEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut attempt = 0u32;
    let mut backoff_secs = 1u64;

    loop {
        let attempt_fut = attempt_download(&client, &url, &dest, &on_progress);
        let result = match tokio::time::timeout(ATTEMPT_TIMEOUT, attempt_fut).await {
            Ok(r) => r,
            Err(_) => Err(format!(
                "download attempt exceeded {}s; aborting",
                ATTEMPT_TIMEOUT.as_secs()
            )),
        };
        match result {
            Ok(()) => {
                let _ = on_progress.send(DownloadEvent::Done);
                return Ok(());
            }
            Err(e) if attempt < MAX_RETRIES => {
                attempt += 1;
                let _ = on_progress.send(DownloadEvent::Retrying {
                    attempt,
                    max_attempts: MAX_RETRIES,
                    delay_secs: backoff_secs,
                    error: e.clone(),
                });
                tokio::time::sleep(tokio::time::Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(16);
            }
            Err(e) => {
                let _ = on_progress.send(DownloadEvent::Error {
                    message: format!("Download failed after {MAX_RETRIES} attempts: {e}"),
                });
                return Err(format!("Download failed after {MAX_RETRIES} attempts: {e}"));
            }
        }
    }
}

async fn attempt_download(
    client: &reqwest::Client,
    url: &str,
    dest: &str,
    on_progress: &Channel<DownloadEvent>,
) -> Result<(), String> {
    // Check for existing partial file to enable resume
    let existing_size = tokio::fs::metadata(dest)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let mut req = client.get(url);
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={existing_size}-"));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    // 416 Range Not Satisfiable: local partial is at-or-past the
    // server's content length. Common path is "previous run already
    // downloaded the whole file"; rather than infinite-retrying the
    // same dead Range, treat as complete and let the caller SHA-verify.
    // If the verify succeeds, install proceeds; if it fails, the user's
    // retry button calls delete_partial then starts a clean download.
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = on_progress.send(DownloadEvent::Progress {
            downloaded: existing_size,
            total: existing_size,
            bytes_per_sec: 0,
        });
        return Ok(());
    }

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    // Resume vs restart decision:
    //   - We sent Range AND server replied 206 → resume (append).
    //   - We sent Range AND server replied 200 → CDN/server ignored
    //     Range and is sending the full body from byte 0. We MUST
    //     truncate the stale partial; otherwise we'd append a fresh
    //     full-file body to the partial and produce a corrupt blob
    //     that fails SHA verification. (Observed against the CDN
    //     fronting download.fridayplatform.io, 2026-04-28.)
    //   - First attempt (existing_size == 0) → fresh download.
    let resuming = existing_size > 0
        && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    let content_length = response.content_length().unwrap_or(0);
    let total = if resuming {
        existing_size + content_length
    } else {
        content_length
    };

    let mut file = if resuming {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(dest)
            .await
            .map_err(|e| format!("Failed to open destination file: {e}"))?
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(dest)
            .await
            .map_err(|e| format!("Failed to open destination file: {e}"))?
    };

    let mut downloaded = if resuming { existing_size } else { 0 };
    let mut stream = response.bytes_stream();
    let start = Instant::now();
    let mut last_report_time = start;
    let mut bytes_since_speed_calc = 0u64;

    loop {
        // Per-chunk idle timeout. A bare `stream.next().await` would hang
        // forever if the server delivered every byte but never closed the
        // stream (Cloudflare HTTP/2 missing END_STREAM, observed
        // 2026-04-28). Wrapping in tokio::time::timeout means the worst
        // case is bounded — we surface the stall as a stream error and
        // let the outer retry loop start a fresh attempt.
        let chunk = match tokio::time::timeout(CHUNK_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(e))) => return Err(format!("Stream error: {e}")),
            Ok(None) => break, // stream cleanly ended
            Err(_) => {
                return Err(format!(
                    "stream stalled with no data for {}s (downloaded {downloaded} / {total})",
                    CHUNK_IDLE_TIMEOUT.as_secs()
                ))
            }
        };
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;

        let chunk_len = chunk.len() as u64;
        downloaded += chunk_len;
        bytes_since_speed_calc += chunk_len;

        if last_report_time.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            let elapsed = last_report_time.elapsed().as_secs_f64().max(0.001);
            let bytes_per_sec = (bytes_since_speed_calc as f64 / elapsed) as u64;

            let _ = on_progress.send(DownloadEvent::Progress {
                downloaded,
                total,
                bytes_per_sec,
            });

            bytes_since_speed_calc = 0;
            last_report_time = Instant::now();
        }

        // Some HTTP servers keep the connection alive after sending the
        // last byte instead of returning None promptly — observed on
        // 2026-04-27 with a fresh download that hit 100% but the wizard
        // never advanced because stream.next() was still polling.
        // If we've received every byte we expected, break out: the
        // outer Done event + SHA verify steps don't need the stream
        // to emit None to be correct.
        if total > 0 && downloaded >= total {
            break;
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {e}"))?;

    // Final progress event — pin total to the real downloaded byte count so
    // a content-length / actual-bytes mismatch (e.g. transparent gzip) can
    // never leave the bar at 99%. Done is the next event the wizard sees.
    let total_elapsed = start.elapsed().as_secs_f64().max(0.001);
    let bytes_per_sec = (downloaded as f64 / total_elapsed) as u64;
    let _ = on_progress.send(DownloadEvent::Progress {
        downloaded,
        total: downloaded,
        bytes_per_sec,
    });

    Ok(())
}
