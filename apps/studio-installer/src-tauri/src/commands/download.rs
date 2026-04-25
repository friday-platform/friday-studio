use futures_util::StreamExt;
use serde::Serialize;
use std::time::Instant;
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
        match attempt_download(&client, &url, &dest, &on_progress).await {
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

    if !response.status().is_success()
        && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
    {
        return Err(format!("HTTP error: {}", response.status()));
    }

    let content_length = response.content_length().unwrap_or(0);
    let total = if existing_size > 0 {
        existing_size + content_length
    } else {
        content_length
    };

    let mut file = OpenOptions::new()
        .create(true)
        .append(existing_size > 0)
        .write(!existing_size > 0 || existing_size == 0)
        .open(dest)
        .await
        .map_err(|e| format!("Failed to open destination file: {e}"))?;

    let mut downloaded = existing_size;
    let mut stream = response.bytes_stream();
    let start = Instant::now();
    let mut last_report_time = start;
    let mut bytes_since_speed_calc = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
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
