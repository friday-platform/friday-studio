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

/// Pure helper extracted for testability — answers "should we emit
/// a progress event right now?" given the throttle state. The first
/// tick always emits so the wizard switches off the generic
/// "Extracting…" copy promptly; subsequent ticks are gated to one
/// per `PROGRESS_EMIT_INTERVAL`. A regression that drops the
/// first-tick override would freeze the UI on the generic copy for
/// up to 200ms — invisible on a 1 GB archive but very visible on a
/// 50-file archive that finishes in 80ms. Pinning this in tests
/// catches that.
fn should_emit_progress(started: bool, last_emit: Instant, now: Instant) -> bool {
    if !started {
        return true;
    }
    now.duration_since(last_emit) >= PROGRESS_EMIT_INTERVAL
}

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
        if should_emit_progress(self.started, self.last_emit, now) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tick_always_emits_regardless_of_clock() {
        // started=false ⇒ emit, no matter what the timestamps say.
        // A regression that drops the !started branch would freeze
        // the wizard's "Extracting…" copy until ≥200ms elapsed.
        let now = Instant::now();
        assert!(should_emit_progress(false, now, now));
        assert!(should_emit_progress(false, now, now + Duration::from_secs(1)));
    }

    #[test]
    fn intermediate_tick_suppressed_inside_throttle_window() {
        let last = Instant::now();
        // last_emit = now - 100ms (< 200ms window) ⇒ suppress.
        let now = last + Duration::from_millis(100);
        assert!(!should_emit_progress(true, last, now));
    }

    #[test]
    fn promote_replaces_archive_paths_and_preserves_user_data() {
        // Pin the load-bearing invariant: extract MUST replace any
        // path the new archive ships AND leave every other path in
        // dest untouched. A regression that wiped dest before extract
        // (e.g. by reverting to the rename-to-bak pattern) would
        // delete user data — chats, memory, workspaces — on every
        // reinstall. VM-tested 2026-05-06.
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("local");
        let staging = tmp.path().join("local.staging");

        // Seed dest with: a binary tree the new archive will replace
        // (bin/), plus user data the new archive doesn't ship
        // (workspaces/, nats/, .env, friday.yml).
        fs::create_dir_all(dest.join("bin")).unwrap();
        fs::write(dest.join("bin").join("friday"), b"OLD-BINARY").unwrap();
        fs::create_dir_all(dest.join("workspaces").join("imported-abc")).unwrap();
        fs::write(
            dest.join("workspaces").join("imported-abc").join("workspace.yml"),
            b"name: dnd campaign",
        )
        .unwrap();
        fs::create_dir_all(dest.join("nats").join("jetstream").join("$G").join("streams").join("CHAT_x")).unwrap();
        fs::write(
            dest.join("nats").join("jetstream").join("$G").join("streams").join("CHAT_x").join("meta.inf"),
            b"chat data",
        )
        .unwrap();
        fs::write(dest.join(".env"), b"ANTHROPIC_API_KEY=secret").unwrap();
        fs::write(dest.join("friday.yml"), b"models: {}").unwrap();

        // Seed staging with what the archive would produce: a NEW
        // bin/, plus a fresh friday-launcher binary. Note: archive
        // does NOT ship workspaces/, nats/, .env, friday.yml.
        fs::create_dir_all(staging.join("bin")).unwrap();
        fs::write(staging.join("bin").join("friday"), b"NEW-BINARY").unwrap();
        fs::write(staging.join("friday-launcher"), b"NEW-LAUNCHER").unwrap();

        promote_staging_into_dest(&staging, &dest).unwrap();

        // Archive paths replaced: bin/friday is the NEW binary.
        assert_eq!(
            fs::read(dest.join("bin").join("friday")).unwrap(),
            b"NEW-BINARY"
        );
        assert_eq!(
            fs::read(dest.join("friday-launcher")).unwrap(),
            b"NEW-LAUNCHER"
        );

        // User data untouched: workspaces/, nats/, .env, friday.yml.
        assert_eq!(
            fs::read(dest.join("workspaces").join("imported-abc").join("workspace.yml")).unwrap(),
            b"name: dnd campaign",
            "workspaces/imported-abc/workspace.yml was deleted — this is the bug we just fixed"
        );
        assert_eq!(
            fs::read(
                dest.join("nats")
                    .join("jetstream")
                    .join("$G")
                    .join("streams")
                    .join("CHAT_x")
                    .join("meta.inf")
            )
            .unwrap(),
            b"chat data",
            "nats/jetstream/.../CHAT_x was deleted — would destroy chat history"
        );
        assert_eq!(
            fs::read(dest.join(".env")).unwrap(),
            b"ANTHROPIC_API_KEY=secret"
        );
        assert_eq!(fs::read(dest.join("friday.yml")).unwrap(), b"models: {}");
    }

    #[test]
    fn intermediate_tick_emits_at_or_past_throttle_window() {
        let last = Instant::now();
        // Exactly at the boundary: emit (>= window).
        let at_boundary = last + PROGRESS_EMIT_INTERVAL;
        assert!(should_emit_progress(true, last, at_boundary));
        // Past the boundary: also emit.
        let past = last + PROGRESS_EMIT_INTERVAL + Duration::from_millis(50);
        assert!(should_emit_progress(true, last, past));
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
    let zst = ruzstd::decoding::StreamingDecoder::new(file)
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

/// Extract the studio archive into `<dest>` while preserving every file
/// in `<dest>` that isn't part of the new archive.
///
/// `<dest>` is the install root (typically `~/.friday/local`). It also
/// holds user state alongside the binaries: `.env`, `friday.yml`,
/// `workspaces/`, `nats/` (JetStream store), `uv/`, `link-data/`, etc.
/// **None of those must be deleted on reinstall** — losing
/// `workspaces/<id>/workspace.yml` orphans the corresponding
/// `KV_WORKSPACE_REGISTRY` entry; losing `nats/jetstream/` destroys
/// every chat / memory / artifact across all workspaces.
///
/// Strategy:
///   1. Extract the archive into a sibling staging dir
///      `<dest>.staging` (so a partial extract can't taint the live
///      tree).
///   2. On success, walk the staging dir's TOP-LEVEL entries. For each
///      one, atomically replace the corresponding entry in `<dest>` —
///      the new tree wins for any path the archive ships, but anything
///      in `<dest>` that the archive doesn't ship (workspaces/, nats/,
///      uv/, etc.) is left untouched.
///   3. On failure, drop the staging dir; `<dest>` is unchanged.
///
/// `on_progress` carries a Tauri Channel the wizard subscribes to for
/// the running entry count.
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

    let staging_path = dest_path.with_extension("staging");

    // Clean any stale staging dir from a prior failed run.
    if staging_path.exists() {
        fs::remove_dir_all(&staging_path)
            .map_err(|e| format!("Failed to remove stale staging dir: {e}"))?;
    }

    // Ensure dest exists (first install) — but DO NOT touch its contents.
    fs::create_dir_all(&dest_path)
        .map_err(|e| format!("Failed to create install dir: {e}"))?;

    fs::create_dir_all(&staging_path)
        .map_err(|e| format!("Failed to create staging dir: {e}"))?;

    // Stop any running studio processes before swapping binaries —
    // overwriting a running binary mid-execution is a portability
    // minefield (Linux silently swaps inode, macOS Gatekeeper
    // revalidates, Windows outright refuses with sharing violation).
    terminate_studio_processes();

    let mut emitter = ProgressEmitter::new(on_progress);
    let result = if is_tar_gz {
        extract_tar_gz(&src_path, &staging_path, &mut emitter)
    } else if is_tar_zst {
        extract_tar_zst(&src_path, &staging_path, &mut emitter)
    } else {
        extract_zip(&src_path, &staging_path, &mut emitter)
    };

    if let Err(e) = result {
        let _ = emitter.channel.send(ExtractEvent::Error {
            message: e.clone(),
        });
        let _ = fs::remove_dir_all(&staging_path);
        return Err(e);
    }

    emitter.finish();

    // Promote staging into dest. For each top-level entry in staging,
    // remove the corresponding entry in dest (if any) and rename the
    // staged version into place. Entries in dest that aren't in the
    // archive — user data — are never touched.
    if let Err(e) = promote_staging_into_dest(&staging_path, &dest_path) {
        let _ = fs::remove_dir_all(&staging_path);
        return Err(e);
    }

    // staging should be empty after the renames; clean it up.
    let _ = fs::remove_dir_all(&staging_path);
    Ok(())
}

/// Walk the staging dir's top-level entries and atomically replace the
/// matching entries in `dest`. Entries in `dest` not present in
/// staging are left alone — that's how user state survives across
/// reinstalls.
fn promote_staging_into_dest(staging: &Path, dest: &Path) -> Result<(), String> {
    let entries = fs::read_dir(staging)
        .map_err(|e| format!("read staging dir {}: {e}", staging.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("staging entry: {e}"))?;
        let name = entry.file_name();
        let from = staging.join(&name);
        let to = dest.join(&name);
        if to.exists() || to.is_symlink() {
            // Need to drop the existing entry first because rename's
            // overwrite behaviour differs across platforms (POSIX
            // overwrites a regular file but errors on a non-empty
            // directory; Windows errors on any existing target).
            let target_meta = fs::symlink_metadata(&to)
                .map_err(|e| format!("stat {}: {e}", to.display()))?;
            if target_meta.is_dir() && !target_meta.file_type().is_symlink() {
                fs::remove_dir_all(&to)
                    .map_err(|e| format!("replace dir {}: {e}", to.display()))?;
            } else {
                fs::remove_file(&to)
                    .map_err(|e| format!("replace file {}: {e}", to.display()))?;
            }
        }
        fs::rename(&from, &to)
            .map_err(|e| format!("promote {} -> {}: {e}", from.display(), to.display()))?;
    }
    Ok(())
}
