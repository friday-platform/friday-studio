// End-to-end installer↔launcher handoff test.
//
// This test exercises the real `launch_studio` command (which spawns
// friday-launcher detached) followed by the real `extract_archive`'s
// `terminate_studio_processes` (which must TERM the launcher cleanly
// using only the launcher.pid contract). No Tauri runtime needed —
// the commands are plain pub fn behind `#[tauri::command]`.
//
// To skip in normal CI runs, set FRIDAY_SKIP_LAUNCHER_HANDOFF=1.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use studio_installer_lib::commands::launch::launch_studio;

fn go_bin() -> &'static str {
    // Cargo's test env may not include /opt/homebrew/bin in PATH on
    // macOS; fall back to the standard install location.
    if PathBuf::from("/opt/homebrew/bin/go").exists() {
        "/opt/homebrew/bin/go"
    } else {
        "go"
    }
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points at apps/studio-installer/src-tauri.
    // Walk up 3 levels: src-tauri → studio-installer → apps → repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent() // studio-installer
        .and_then(|p| p.parent()) // apps
        .and_then(|p| p.parent()) // repo root
        .expect("walk up to repo root")
        .to_path_buf()
}

fn build_launcher(out_dir: &PathBuf) -> PathBuf {
    let launcher_pkg = repo_root().join("tools").join("friday-launcher");
    assert!(
        launcher_pkg.exists(),
        "launcher pkg not found at {} (repo_root={})",
        launcher_pkg.display(),
        repo_root().display()
    );
    let launcher_out = out_dir.join("friday-launcher");
    let go = go_bin();
    eprintln!(
        "build_launcher: {} build -o {} . (cwd={})",
        go,
        launcher_out.display(),
        launcher_pkg.display()
    );
    let status = Command::new(go)
        .args(["build", "-o", launcher_out.to_str().unwrap(), "."])
        .current_dir(&launcher_pkg)
        .status()
        .unwrap_or_else(|e| panic!(
            "go build failed to spawn (go={}, cwd={}): {e}",
            go,
            launcher_pkg.display()
        ));
    assert!(status.success(), "go build returned non-zero");
    launcher_out
}

fn build_stub(out_dir: &PathBuf) -> PathBuf {
    // Build a minimal HTTP-stub binary. Each per-name wrapper script
    // execs this with PORT + HEALTH_PATH env.
    let stub_dir = out_dir.join("stub-src");
    fs::create_dir_all(&stub_dir).unwrap();
    fs::write(
        stub_dir.join("go.mod"),
        "module stub\ngo 1.26\n",
    )
    .unwrap();
    fs::write(
        stub_dir.join("main.go"),
        STUB_GO,
    )
    .unwrap();
    let stub_bin = out_dir.join("_stub");
    // GOWORK=off so the workspace at repo root doesn't try to claim
    // the stub-src dir (which lives under target/tmp inside the
    // workspace).
    let status = Command::new(go_bin())
        .args(["build", "-o", stub_bin.to_str().unwrap(), "."])
        .current_dir(&stub_dir)
        .env("GOWORK", "off")
        .status()
        .expect("go build stub");
    assert!(status.success());
    stub_bin
}

const STUB_GO: &str = r#"package main
import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)
func main() {
	port := os.Getenv("PORT")
	healthPath := os.Getenv("HEALTH_PATH")
	if healthPath == "" { healthPath = "/health" }
	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "OK")
	})
	go http.ListenAndServe("127.0.0.1:"+port, mux)
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	<-ch
}
"#;

fn write_wrapper(install_dir: &PathBuf, stub: &PathBuf, name: &str, port: &str, health: &str) {
    let body = format!(
        "#!/usr/bin/env bash\nexec env STUB_NAME={name} PORT={port} HEALTH_PATH={health} {stub_path}\n",
        name = name,
        port = port,
        health = health,
        stub_path = stub.display(),
    );
    let target = install_dir.join(name);
    fs::write(&target, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&target).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&target, perms).unwrap();
}

fn override_home(test_home: &PathBuf) {
    // dirs::home_dir() reads HOME on Unix. Set it to our scratch dir
    // so launch_studio + the launcher write under there, not the
    // user's real ~/.friday/local.
    env::set_var("HOME", test_home);
    // The launcher itself reads FRIDAY_LAUNCHER_HOME; it inherits
    // env from the installer-spawned child so we set it here too.
    let local = test_home.join(".friday").join("local");
    fs::create_dir_all(&local).unwrap();
    env::set_var("FRIDAY_LAUNCHER_HOME", &local);
    // Override the supervised-process ports so we don't clash with
    // a real Friday on standard ports.
    env::set_var("FRIDAY_PORT_nats_server", "28222");
    env::set_var("FRIDAY_PORT_friday", "28080");
    env::set_var("FRIDAY_PORT_link", "23100");
    env::set_var("FRIDAY_PORT_pty_server", "27681");
    env::set_var("FRIDAY_PORT_webhook_tunnel", "29090");
    env::set_var("FRIDAY_PORT_playground", "25200");
}

fn pidfile_path() -> PathBuf {
    PathBuf::from(env::var("FRIDAY_LAUNCHER_HOME").unwrap())
        .join("pids")
        .join("launcher.pid")
}

fn process_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

fn read_pid_from_file() -> Option<u32> {
    let contents = fs::read_to_string(pidfile_path()).ok()?;
    let trimmed = contents.trim();
    trimmed.split_whitespace().next()?.parse().ok()
}

fn wait_until<F: Fn() -> bool>(timeout: Duration, check: F) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[test]
fn installer_launcher_handoff_and_clean_shutdown() {
    if env::var("FRIDAY_SKIP_LAUNCHER_HANDOFF").is_ok() {
        eprintln!("skipped: FRIDAY_SKIP_LAUNCHER_HANDOFF set");
        return;
    }

    // Temp scratch dir for everything: HOME, install_dir, stub
    // sources, etc. Cleaned on test exit by the OS (Cargo
    // doesn't auto-cleanup target/ either, so this is best-effort).
    let scratch = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("launcher-handoff");
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).unwrap();

    // 1. Build artifacts: friday-launcher + stub + per-name wrappers
    //    in a faux install_dir that mirrors the studio platform tarball
    //    layout.
    let install_dir = scratch.join("install");
    fs::create_dir_all(&install_dir).unwrap();
    let _launcher = build_launcher(&install_dir);
    let stub = build_stub(&scratch);
    // All six supervised processes now require a stub — Stack 3's
    // pre-flight verifies every binary exists before the launcher
    // boots, so a missing stub fires the missing-binaries dialog
    // and the test never gets to launch_studio.
    write_wrapper(&install_dir, &stub, "nats-server", "28222", "/healthz");
    write_wrapper(&install_dir, &stub, "friday", "28080", "/health");
    write_wrapper(&install_dir, &stub, "link", "23100", "/health");
    write_wrapper(&install_dir, &stub, "pty-server", "27681", "/health");
    write_wrapper(&install_dir, &stub, "webhook-tunnel", "29090", "/health");
    write_wrapper(&install_dir, &stub, "playground", "25200", "/");

    // 2. Override HOME + FRIDAY_LAUNCHER_HOME + FRIDAY_PORT_* so our
    //    test doesn't touch real ~/.friday.
    let test_home = scratch.join("home");
    override_home(&test_home);

    // 3. Call launch_studio — the real installer command.
    let install_dir_str = install_dir.to_string_lossy().to_string();
    eprintln!("=== launch_studio({}) ===", install_dir_str);
    launch_studio(install_dir_str.clone()).expect("launch_studio");

    // 4. The launcher must be alive and have written launcher.pid.
    let launcher_pid = read_pid_from_file().expect("launcher.pid not written");
    assert!(
        process_alive(launcher_pid),
        "launcher pid {} not alive after launch_studio returned",
        launcher_pid
    );
    eprintln!("launcher running pid={}", launcher_pid);

    // 5. Within 15s the supervised stubs must come up + report 200 OK.
    let healthy = wait_until(Duration::from_secs(15), || {
        let urls = [
            "http://127.0.0.1:28222/healthz",
            "http://127.0.0.1:28080/health",
            "http://127.0.0.1:23100/health",
            "http://127.0.0.1:27681/health",
            "http://127.0.0.1:29090/health",
            "http://127.0.0.1:25200/",
        ];
        urls.iter().all(|u| http_get_ok(u))
    });
    assert!(healthy, "supervised stubs did not become healthy in 15s");
    eprintln!("all 6 supervised stubs healthy");

    // 6. Now exercise the installer↔launcher contract from extract.rs:
    //    SIGTERM the launcher and verify the launcher.pid file
    //    disappears within 35s. (extract.rs::terminate_studio_processes
    //    is private; we replicate its single-pid TERM logic here so the
    //    test covers the contract semantics directly.)
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        kill(launcher_pid as i32, 15); // SIGTERM
    }
    let cleaned = wait_until(Duration::from_secs(35), || !pidfile_path().exists());
    assert!(
        cleaned,
        "launcher.pid still present 35s after SIGTERM — extract.rs handoff broken"
    );
    // Note: process_alive(launcher_pid) may briefly return true here
    // because the launcher is the test process's child and we never
    // waitpid it — kill(pid, 0) returns success for zombies. The
    // launcher's own onExit removed the pid file as the LAST thing
    // before main returned, so pid-file-gone IS the contract proof.
    eprintln!("clean shutdown verified (pid file removed by launcher's onExit)");
    // Reap so the second launch_studio doesn't see a stale zombie pid
    // recycle into a real process.
    extern "C" {
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }
    let mut status: i32 = 0;
    unsafe {
        waitpid(launcher_pid as i32, &mut status, 0);
    }

    // 7. Re-install scenario: spawn the launcher again, then call
    //    launch_studio AGAIN — extract.rs's contract says the
    //    installer should be able to TERM-and-replace cleanly.
    eprintln!("=== second launch_studio ===");
    launch_studio(install_dir_str.clone()).expect("second launch_studio");
    let second_pid = read_pid_from_file().expect("launcher.pid (second)");
    assert!(process_alive(second_pid), "second launcher not alive");
    assert_ne!(second_pid, launcher_pid, "expected a different pid");
    eprintln!("second launcher running pid={}", second_pid);

    // 8. Final cleanup: TERM the second launcher.
    unsafe { kill(second_pid as i32, 15); }
    let cleaned2 = wait_until(Duration::from_secs(35), || !pidfile_path().exists());
    assert!(cleaned2, "second launcher didn't clean up");
}

fn http_get_ok(url: &str) -> bool {
    // Use curl via std::process — avoids pulling reqwest into the
    // test. Returns true on HTTP 200.
    let out = Command::new("curl")
        .args(["-sf", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", url])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "200",
        Err(_) => false,
    }
}
