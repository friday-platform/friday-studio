use std::fs;
use std::path::PathBuf;

fn friday_pids_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".friday").join("local").join("pids"))
}

fn process_exists(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // kill -0 checks existence without sending a signal
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        unsafe { kill(pid as i32, 0) == 0 }
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            CloseHandle(handle);
            true
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

#[tauri::command]
pub fn check_running_processes() -> Result<bool, String> {
    let pids_dir = match friday_pids_dir() {
        Some(d) => d,
        None => return Ok(false),
    };

    if !pids_dir.exists() {
        return Ok(false);
    }

    let entries = fs::read_dir(&pids_dir)
        .map_err(|e| format!("Failed to read pids dir: {e}"))?;

    let mut any_alive = false;

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
            Err(_) => {
                // Stale/corrupted pid file — remove it
                let _ = fs::remove_file(&path);
                continue;
            }
        };

        if process_exists(pid) {
            any_alive = true;
        } else {
            // Stale pid file — clean up
            let _ = fs::remove_file(&path);
        }
    }

    Ok(any_alive)
}
