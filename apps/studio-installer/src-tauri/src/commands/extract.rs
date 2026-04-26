use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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

fn extract_tar_gz(src: &Path, dest: &Path) -> Result<(), String> {
    let file =
        fs::File::open(src).map_err(|e| format!("Cannot open archive {}: {e}", src.display()))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| format!("tar.gz extraction failed: {e}"))
}

fn extract_zip(src: &Path, dest: &Path) -> Result<(), String> {
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
    }

    Ok(())
}

/// Backs up an existing install by renaming `<dest>` to `<dest>.bak` (sibling),
/// extracts the new archive into `<dest>`, then either commits (deletes bak)
/// or rolls back (restores bak). Treats `<dest>` itself as the install root —
/// the studio archive expands flat (atlas, link, playground, webhook-tunnel,
/// gh, cloudflared at the top level).
#[tauri::command]
pub fn extract_archive(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);

    let is_tar_gz = src.ends_with(".tar.gz") || src.ends_with(".tgz");
    let is_zip = src.ends_with(".zip");
    if !is_tar_gz && !is_zip {
        return Err(format!(
            "Unknown archive format for: {src}. Expected .tar.gz or .zip"
        ));
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

    let result = if is_tar_gz {
        extract_tar_gz(&src_path, &dest_path)
    } else {
        extract_zip(&src_path, &dest_path)
    };

    match result {
        Ok(()) => {
            if bak_path.exists() {
                let _ = fs::remove_dir_all(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            // Roll back: drop the partial new install and restore the backup.
            if bak_path.exists() {
                let _ = fs::remove_dir_all(&dest_path);
                let _ = fs::rename(&bak_path, &dest_path);
            }
            Err(e)
        }
    }
}
