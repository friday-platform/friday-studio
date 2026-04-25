use std::fs;
use std::path::{Path, PathBuf};

fn terminate_studio_processes() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let pids_dir = home.join(".friday").join("local").join("pids");

    if !pids_dir.exists() {
        return;
    }

    let entries = match fs::read_dir(&pids_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pid") {
            continue;
        }
        let pid_str = match fs::read_to_string(&path) {
            Ok(s) => s.trim().to_string(),
            Err(_) => continue,
        };
        let pid: u32 = match pid_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };

        #[cfg(unix)]
        {
            // SIGTERM
            libc_kill(pid as i32, 15);
        }

        #[cfg(windows)]
        {
            // Use taskkill as it doesn't require windows_sys as a dep
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
    }

    // Wait up to 10s for processes to exit
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
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

#[tauri::command]
pub fn extract_archive(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);

    // Determine format
    let is_tar_gz = src.ends_with(".tar.gz") || src.ends_with(".tgz");
    let is_zip = src.ends_with(".zip");

    if !is_tar_gz && !is_zip {
        return Err(format!(
            "Unknown archive format for: {src}. Expected .tar.gz or .zip"
        ));
    }

    // Handle update: backup existing install directory
    // Find the top-level app directory inside dest
    let app_dir = dest_path.join("Friday Studio.app");
    let bak_dir = dest_path.join("Friday Studio.app.bak");

    // Clean stale backup
    if bak_dir.exists() {
        fs::remove_dir_all(&bak_dir)
            .map_err(|e| format!("Failed to remove stale backup: {e}"))?;
    }

    // Terminate any running studio processes before extraction
    if app_dir.exists() {
        terminate_studio_processes();
        fs::rename(&app_dir, &bak_dir)
            .map_err(|e| format!("Failed to backup existing install: {e}"))?;
    }

    let result = if is_tar_gz {
        extract_tar_gz(&src_path, &dest_path)
    } else {
        extract_zip(&src_path, &dest_path)
    };

    match result {
        Ok(()) => {
            // Remove backup on success
            if bak_dir.exists() {
                let _ = fs::remove_dir_all(&bak_dir);
            }
            Ok(())
        }
        Err(e) => {
            // Restore backup on failure
            if bak_dir.exists() {
                if app_dir.exists() {
                    let _ = fs::remove_dir_all(&app_dir);
                }
                let _ = fs::rename(&bak_dir, &app_dir);
            }
            Err(e)
        }
    }
}
