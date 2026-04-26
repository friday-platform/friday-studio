// launch.rs — installer's wizard final step.
//
// Per the friday-launcher design (docs/plans/2026-04-25-friday-launcher-design.v8.md),
// the installer's job here collapses to:
//   1. Spawn `friday-launcher` detached.
//   2. Return.
//
// All process supervision, health polling, restart-on-crash, browser
// auto-open, autostart-at-login, and tray UI are owned by the launcher
// itself. The installer no longer writes per-process pid files (the
// launcher owns the pid-file contract — single launcher.pid with flock)
// and no longer runs `tauri-plugin-autostart` (the launcher
// self-registers on first run so the LaunchAgent plist points at the
// launcher's `os.Executable()` path, not the installer's).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn friday_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".friday")
        .join("local")
}

/// Resolve the launcher binary path. On macOS the launcher ships
/// inside `Friday Studio.app/Contents/MacOS/friday-launcher`; on
/// Windows + Linux it sits flat at `<install_dir>/friday-launcher`
/// (.exe suffix on Windows).
fn launcher_path(install_dir: &str) -> PathBuf {
    let install = Path::new(install_dir);

    #[cfg(target_os = "macos")]
    {
        // Prefer the .app bundle if it exists; fall back to flat.
        let app_path = install
            .join("Friday Studio.app")
            .join("Contents")
            .join("MacOS")
            .join("friday-launcher");
        if app_path.exists() {
            return app_path;
        }
    }

    #[cfg(target_os = "windows")]
    {
        return install.join("friday-launcher.exe");
    }

    install.join("friday-launcher")
}

/// Spawn the launcher detached. On Unix we double-fork via setsid so
/// the launcher survives the installer process exiting; on Windows
/// CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS achieves the same.
fn spawn_launcher_detached(launcher: &Path) -> Result<u32, String> {
    let log_dir = friday_home().join("logs");
    fs::create_dir_all(&log_dir).map_err(|e| format!("Failed to create logs dir: {e}"))?;

    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("launcher-stdout.log"))
        .map_err(|e| format!("Failed to open launcher-stdout.log: {e}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {e}"))?;

    let mut cmd = Command::new(launcher);
    cmd.stdout(stdout).stderr(stderr).stdin(std::process::Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid → new session, detached from installer's controlling
        // terminal. When the installer's wizard closes the launcher
        // keeps running independently. Raw extern "C" avoids pulling
        // libc in as a dep (extract.rs takes the same shortcut).
        extern "C" {
            fn setsid() -> i32;
        }
        unsafe {
            cmd.pre_exec(|| {
                if setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS = 0x00000008
        // CREATE_NEW_PROCESS_GROUP = 0x00000200
        // CREATE_NO_WINDOW = 0x08000000  (suppress console window)
        cmd.creation_flags(0x00000008 | 0x00000200 | 0x08000000);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn friday-launcher: {e}"))?;
    Ok(child.id())
}

/// Wait until launcher.pid appears + the recorded pid is alive. Up
/// to `timeout_secs` seconds. Surfaces "the launcher we just spawned
/// crashed during boot" early instead of returning success and
/// leaving the user with an empty tray.
fn poll_launcher_alive(timeout_secs: u64) -> Result<(), String> {
    let pid_file = friday_home().join("pids").join("launcher.pid");
    let start = Instant::now();
    let deadline = Duration::from_secs(timeout_secs);

    while start.elapsed() < deadline {
        if let Ok(contents) = fs::read_to_string(&pid_file) {
            let trimmed = contents.trim();
            if let Some(pid_str) = trimmed.split_whitespace().next() {
                if let Ok(pid) = pid_str.parse::<i32>() {
                    if pid > 0 && process_alive(pid) {
                        return Ok(());
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "friday-launcher did not appear in {} after {}s. Check logs at {}.",
        pid_file.display(),
        timeout_secs,
        friday_home().join("logs").join("launcher-stdout.log").display(),
    ))
}

#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn process_alive(pid: i32) -> bool {
    use std::process::Command;
    // Best-effort check via tasklist (avoids pulling in windows_sys
    // here — extract.rs already takes the same shortcut for taskkill).
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn launch_studio(install_dir: String) -> Result<(), String> {
    let launcher = launcher_path(&install_dir);
    if !launcher.exists() {
        return Err(format!(
            "friday-launcher binary not found at {}. The installer archive may be incomplete.",
            launcher.display()
        ));
    }

    let pid = spawn_launcher_detached(&launcher)?;
    eprintln!(
        "studio-installer: spawned friday-launcher pid={} from {}",
        pid,
        launcher.display()
    );

    // Confirm the launcher actually got past startup (acquired the
    // pid-file lock). 15s is generous — the launcher hits the lock
    // within ~100 ms in practice.
    poll_launcher_alive(15)?;

    Ok(())
}
