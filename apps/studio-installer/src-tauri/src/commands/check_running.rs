use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

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

/// Port the launcher's HTTP health server binds to. Single source
/// of truth for the wizard side; matches the launcher's own
/// healthServerPort const ("5199" in tools/friday-launcher).
const LAUNCHER_HEALTH_PORT: u16 = 5199;

#[tauri::command]
pub fn check_running_processes() -> Result<bool, String> {
    // Primary signal: is anything listening on port 5199?
    //
    // The pid-file fallback below covers a previous-version launcher
    // that didn't bind 5199, but any modern launcher (Stack 1+) does
    // — and crucially, that's the exact resource the new launcher
    // collides with on update. Detecting via the port directly works
    // regardless of which binary is running it (~/.friday/local vs
    // /Applications/Friday Studio.app/Contents/MacOS/Friday Studio,
    // which write their pid files to different paths in some
    // configurations and missed each other in
    // ~/.friday/local/pids/launcher.pid).
    if port_in_use(LAUNCHER_HEALTH_PORT) {
        return Ok(true);
    }

    // Fallback: pid-file scan. Useful for older launchers that
    // didn't open 5199 yet but did write a pid file.
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

/// Returns true if a connection to 127.0.0.1:`port` succeeds within
/// 500ms. Connect-refused → false; any other I/O outcome (timeout,
/// host unreachable) is also treated as "not bound" since we'd
/// prefer a false negative on this probe to a false positive that
/// triggers a needless stop-and-restart.
fn port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}
