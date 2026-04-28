use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;

/// Per-entry progress emitted by `extract_archive` to the wizard.
/// The wizard renders "Unpacking… N files" — no total because
/// counting up-front would require a streaming pre-pass over the
/// (often >500 MB) archive.
///
/// Throttled to one event per `PROGRESS_EMIT_INTERVAL` so a million
/// small files don't spam the Tauri IPC channel. The final count is
/// always emitted regardless of throttle so the UI stops at the
/// true total.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExtractEvent {
    Progress { entries_done: u64 },
    Done,
    Error { message: String },
}

/// How often to emit progress events. Sized for "noticeable forward
/// motion" — roughly one update every two render frames at 120Hz.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// Helper that throttles progress emissions to the wizard channel.
/// Always lets the first and last events through; intermediate
/// events are suppressed if they fall within the same throttle
/// window.
struct ProgressEmitter {
    channel: Channel<ExtractEvent>,
    last_emit: Instant,
    entries_done: u64,
    started: bool,
}

impl ProgressEmitter {
    fn new(channel: Channel<ExtractEvent>) -> Self {
        Self {
            channel,
            last_emit: Instant::now(),
            entries_done: 0,
            started: false,
        }
    }

    fn tick(&mut self) {
        self.entries_done += 1;
        let now = Instant::now();
        // First tick always emits so the wizard switches from the
        // generic "Extracting…" copy to the running count promptly.
        let force = !self.started;
        if force || now.duration_since(self.last_emit) >= PROGRESS_EMIT_INTERVAL {
            self.started = true;
            self.last_emit = now;
            let _ = self.channel.send(ExtractEvent::Progress {
                entries_done: self.entries_done,
            });
        }
    }

    /// Always emits a final progress + done event so the wizard's
    /// last rendered count matches what landed on disk.
    fn finish(&mut self) {
        let _ = self.channel.send(ExtractEvent::Progress {
            entries_done: self.entries_done,
        });
        let _ = self.channel.send(ExtractEvent::Done);
    }
}

/// Stops any running launcher before we mutate the install dir.
/// Per the v8 plan installer↔launcher contract, the installer only
/// touches `launcher.pid` (NOT every supervised binary's pid file —
/// those are owned by the launcher). The launcher's own onExit handler
/// drives the orderly shutdown of the 5 supervised processes; we just
/// need to TERM the launcher and wait for its pid file to disappear.
fn terminate_studio_processes() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let pid_file = home.join(".friday").join("local").join("pids").join("launcher.pid");
    if !pid_file.exists() {
        return;
    }

    // pid file format: "<pid> <start_time_unix>"
    let contents = match fs::read_to_string(&pid_file) {
        Ok(s) => s,
        Err(_) => return,
    };
    let trimmed = contents.trim();
    let pid_str = match trimmed.split_whitespace().next() {
        Some(s) => s,
        None => return,
    };
    let pid: u32 = match pid_str.parse() {
        Ok(p) => p,
        Err(_) => return,
    };

    #[cfg(unix)]
    libc_kill(pid as i32, 15); // SIGTERM
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    // Wait up to 35s for the launcher to exit. The launcher's
    // ShutDownProject deadline is 30s; add 5s of jitter for the
    // launcher's own teardown after that.
    let deadline = Duration::from_secs(35);
    let start = Instant::now();
    while start.elapsed() < deadline {
        if !pid_file.exists() {
            return; // launcher's onExit removed the pid file → clean exit
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    // Launcher didn't exit in time. Fall through to extraction anyway —
    // the worst case is that file replacement races with a stuck
    // launcher, which is no worse than the prior behavior.
}

#[cfg(unix)]
fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, sig) }
}

/// Extract a tar archive entry-by-entry, ticking the progress emitter
/// on each entry. Decodes via the supplied Read (gz or zst) — same
/// loop body for both compression types so we don't duplicate the
/// per-entry plumbing twice.
fn extract_tar_streaming<R: Read>(
    reader: R,
    dest: &Path,
    emitter: &mut ProgressEmitter,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| format!("tar entries iteration failed: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar entry read failed: {e}"))?;
        entry
            .unpack_in(dest)
            .map_err(|e| format!("tar entry unpack failed: {e}"))?;
        emitter.tick();
    }
    Ok(())
}

fn extract_tar_gz(
    src: &Path,
    dest: &Path,
    emitter: &mut ProgressEmitter,
) -> Result<(), String> {
    let file =
        fs::File::open(src).map_err(|e| format!("Cannot open archive {}: {e}", src.display()))?;
    let gz = flate2::read::GzDecoder::new(file);
    extract_tar_streaming(gz, dest, emitter)
        .map_err(|e| format!("tar.gz extraction failed: {e}"))
}

fn extract_tar_zst(
    src: &Path,
    dest: &Path,
    emitter: &mut ProgressEmitter,
) -> Result<(), String> {
    let file =
        fs::File::open(src).map_err(|e| format!("Cannot open archive {}: {e}", src.display()))?;
    // ruzstd decoder works on any Read; zstd::Decoder would require linking
    // against libzstd which we'd need to vendor for the install bundle.
    // ruzstd is pure Rust + small + fast enough for one-shot install
    // extraction (a few seconds for a 1 GB archive).
    let zst = ruzstd::StreamingDecoder::new(file)
        .map_err(|e| format!("zstd init failed: {e}"))?;
    extract_tar_streaming(zst, dest, emitter)
        .map_err(|e| format!("tar.zst extraction failed: {e}"))
}

fn extract_zip(
    src: &Path,
    dest: &Path,
    emitter: &mut ProgressEmitter,
) -> Result<(), String> {
    let file =
        fs::File::open(src).map_err(|e| format!("Cannot open archive {}: {e}", src.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip index error: {e}"))?;
        let out_path = dest.join(file.mangled_name());

        if file.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {e}"))?;
            }
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create file {}: {e}", out_path.display()))?;
            std::io::copy(&mut file, &mut out_file)
                .map_err(|e| format!("Failed to extract file: {e}"))?;
        }
        emitter.tick();
    }

    Ok(())
}

/// Backs up an existing install by renaming `<dest>` to `<dest>.bak` (sibling),
/// extracts the new archive into `<dest>`, then either commits (deletes bak)
/// or rolls back (restores bak). Treats `<dest>` itself as the install root —
/// the studio archive expands flat (atlas, link, playground, webhook-tunnel,
/// gh, cloudflared at the top level).
///
/// `on_progress` carries a Tauri Channel the wizard subscribes to for the
/// running entry count. Per Stack 2 the count is the only progress signal —
/// no total, since computing it would require an extra streaming pass over
/// the (often >500 MB) archive. Stack 3 introduces split-destination
/// + staging + atomic swap; this function keeps the prior `.bak`-rollback
/// shape so the Stack 2 PR is small.
#[tauri::command]
pub fn extract_archive(
    src: String,
    dest: String,
    on_progress: Channel<ExtractEvent>,
) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);

    let is_tar_gz = src.ends_with(".tar.gz") || src.ends_with(".tgz");
    let is_tar_zst = src.ends_with(".tar.zst") || src.ends_with(".tzst");
    let is_zip = src.ends_with(".zip");
    if !is_tar_gz && !is_tar_zst && !is_zip {
        let msg = format!(
            "Unknown archive format for: {src}. Expected .tar.gz, .tar.zst, or .zip"
        );
        let _ = on_progress.send(ExtractEvent::Error {
            message: msg.clone(),
        });
        return Err(msg);
    }

    let bak_path = dest_path.with_extension("bak");

    // Clean any stale backup from a prior failed run.
    if bak_path.exists() {
        fs::remove_dir_all(&bak_path)
            .map_err(|e| format!("Failed to remove stale backup: {e}"))?;
    }

    // Stop any running studio processes before mutating the install dir —
    // overwriting a running binary mid-execution is a portability minefield
    // (Linux silently swaps inode, macOS Gatekeeper revalidates, Windows
    // outright refuses with sharing violation).
    if dest_path.exists() {
        terminate_studio_processes();
        fs::rename(&dest_path, &bak_path)
            .map_err(|e| format!("Failed to backup existing install: {e}"))?;
    }

    fs::create_dir_all(&dest_path)
        .map_err(|e| format!("Failed to create install dir: {e}"))?;

    let mut emitter = ProgressEmitter::new(on_progress);
    let result = if is_tar_gz {
        extract_tar_gz(&src_path, &dest_path, &mut emitter)
    } else if is_tar_zst {
        extract_tar_zst(&src_path, &dest_path, &mut emitter)
    } else {
        extract_zip(&src_path, &dest_path, &mut emitter)
    };

    match result {
        Ok(()) => {
            emitter.finish();
            if bak_path.exists() {
                let _ = fs::remove_dir_all(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            let _ = emitter.channel.send(ExtractEvent::Error {
                message: e.clone(),
            });
            // Roll back: drop the partial new install and restore the backup.
            if bak_path.exists() {
                let _ = fs::remove_dir_all(&dest_path);
                let _ = fs::rename(&bak_path, &dest_path);
            }
            Err(e)
        }
    }
}
