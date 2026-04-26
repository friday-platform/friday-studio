use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

fn friday_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".friday")
        .join("local")
}

fn write_pid(name: &str, pid: u32) -> Result<(), String> {
    let pids_dir = friday_home().join("pids");
    fs::create_dir_all(&pids_dir)
        .map_err(|e| format!("Failed to create pids dir: {e}"))?;
    let pid_file = pids_dir.join(format!("{name}.pid"));
    fs::write(&pid_file, pid.to_string().as_bytes())
        .map_err(|e| format!("Failed to write pid file for {name}: {e}"))
}

fn log_path_for(name: &str) -> std::path::PathBuf {
    friday_home().join(format!("{name}.log"))
}

fn spawn_process(install_dir: &str, name: &str, friday_home_path: &str) -> Result<Child, String> {
    #[cfg(unix)]
    let binary = format!("{install_dir}/{name}");
    #[cfg(windows)]
    let binary = format!("{install_dir}\\{name}.exe");

    let log_path = log_path_for(name);
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file for {name}: {e}"))?;

    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {e}"))?;

    // Pin every spawned process's data + memory dirs under the install root
    // so the bundled Friday Studio can't collide with a separate `atlas`
    // dev daemon the user already runs out of `~/.atlas`. ATLAS_HOME is the
    // env var the compiled binary actually reads (FRIDAY_HOME is kept for
    // any in-tree code paths that look at it).
    Command::new(&binary)
        .env("ATLAS_HOME", friday_home_path)
        .env("FRIDAY_HOME", friday_home_path)
        .stdout(log_file)
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("Failed to spawn {name}: {e}"))
}

/// Reads the last few KB of `<friday_home>/<name>.log` so error toasts can
/// surface the actual reason a service exited (port-in-use is the common
/// case on a dev box). Best-effort — returns empty string if anything fails.
fn tail_log(name: &str, max_bytes: usize) -> String {
    let path = log_path_for(name);
    let Ok(bytes) = fs::read(&path) else { return String::new(); };
    let start = bytes.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

fn check_immediate_exit(child: &mut Child, name: &str) -> Result<(), String> {
    std::thread::sleep(Duration::from_millis(100));
    match child.try_wait() {
        Ok(Some(status)) => {
            let code = status.code().unwrap_or(-1);
            let tail = tail_log(name, 1024);
            let log = log_path_for(name).display().to_string();
            if tail.is_empty() {
                Err(format!(
                    "Failed to start {name}: exited with code {code}. See log: {log}"
                ))
            } else {
                Err(format!(
                    "Failed to start {name}: exited with code {code}.\n\nLast log lines:\n{tail}\n\nFull log: {log}"
                ))
            }
        }
        Ok(None) => Ok(()),
        Err(e) => Err(format!("Failed to check {name} status: {e}")),
    }
}

fn poll_http_health(url: &str, timeout_secs: u64) -> Result<(), String> {
    // Use a blocking reqwest via tokio's block_in_place — we're already in an async context
    // but this command is called from Tauri, so we use std-based polling.
    let start = Instant::now();
    let deadline = Duration::from_secs(timeout_secs);

    // Extract host:port from URL for TCP check first, then do HTTP
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Failed to build health client: {e}"))?;

    loop {
        if start.elapsed() >= deadline {
            return Err(format!("{url} did not become healthy within {timeout_secs}s"));
        }

        match client.get(url).send() {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }

        std::thread::sleep(Duration::from_secs(1));
    }
}

fn poll_tcp_port(port: u16, timeout_secs: u64) -> Result<(), String> {
    let addr = format!("127.0.0.1:{port}");
    let start = Instant::now();

    loop {
        if start.elapsed() >= Duration::from_secs(timeout_secs) {
            return Err(format!(
                "Port {port} did not become available within {timeout_secs}s"
            ));
        }

        if TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("Invalid addr: {e}"))?,
            Duration::from_secs(1),
        )
        .is_ok()
        {
            return Ok(());
        }

        std::thread::sleep(Duration::from_secs(1));
    }
}

#[tauri::command]
pub fn launch_studio(install_dir: String) -> Result<(), String> {
    let home = friday_home();
    let home_str = home.to_string_lossy().to_string();

    fs::create_dir_all(&home).map_err(|e| format!("Failed to create FRIDAY_HOME: {e}"))?;
    fs::create_dir_all(home.join("pids"))
        .map_err(|e| format!("Failed to create pids dir: {e}"))?;

    // ── Phase 1: backends ────────────────────────────────────────────────────
    // Daemon binary ships as `friday` (user-visible name); internal codebase
    // still uses "atlas". Health-poll error includes the log tail so the user
    // can see the underlying cause (typically port-already-in-use).

    let mut friday = spawn_process(&install_dir, "friday", &home_str)?;
    check_immediate_exit(&mut friday, "friday")?;
    write_pid("friday", friday.id())?;

    let mut link = spawn_process(&install_dir, "link", &home_str)?;
    check_immediate_exit(&mut link, "link")?;
    write_pid("link", link.id())?;

    poll_http_health("http://localhost:8080/health", 30).map_err(|_| {
        let tail = tail_log("friday", 1024);
        let log = log_path_for("friday").display().to_string();
        if tail.is_empty() {
            format!("Friday daemon did not become healthy within 30s. See log: {log}")
        } else {
            format!("Friday daemon did not become healthy within 30s.\n\nLast log lines:\n{tail}\n\nFull log: {log}")
        }
    })?;
    poll_http_health("http://localhost:3100/health", 30).map_err(|_| {
        let tail = tail_log("link", 1024);
        let log = log_path_for("link").display().to_string();
        if tail.is_empty() {
            format!("Link service did not become healthy within 30s. See log: {log}")
        } else {
            format!("Link service did not become healthy within 30s.\n\nLast log lines:\n{tail}\n\nFull log: {log}")
        }
    })?;

    // ── Phase 2: frontends ───────────────────────────────────────────────────
    // Binary names match the entries we tar into the studio archive (see
    // scripts/build-studio.ts::DENO_BINARIES + GO_BINARIES).

    let mut playground = spawn_process(&install_dir, "playground", &home_str)?;
    check_immediate_exit(&mut playground, "playground")?;
    write_pid("playground", playground.id())?;

    let mut pty = spawn_process(&install_dir, "pty-server", &home_str)?;
    check_immediate_exit(&mut pty, "pty-server")?;
    write_pid("pty-server", pty.id())?;

    let mut tunnel = spawn_process(&install_dir, "webhook-tunnel", &home_str)?;
    check_immediate_exit(&mut tunnel, "webhook-tunnel")?;
    write_pid("webhook-tunnel", tunnel.id())?;

    // Wait for Studio UI port
    poll_tcp_port(5200, 30)?;

    // Open browser
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("http://localhost:5200")
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "http://localhost:5200"])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg("http://localhost:5200")
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    Ok(())
}
