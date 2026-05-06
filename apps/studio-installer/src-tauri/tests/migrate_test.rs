// Integration tests for the migrate Tauri command.
//
// We exercise the command via its underlying async function (the
// #[tauri::command] attribute is metadata-only — the function itself is
// callable as plain async). The command spawns
// `<install_dir>/bin/friday migrate --json`; tests substitute a shell
// script stub for the real binary, so we have full control over stdout,
// stderr, and exit code without coupling to atlas-cli.
//
// FRIDAY_LAUNCHER_HOME is set per-test to point at a tempdir, isolating
// the friday-home resolution and the installer.log writes from the
// developer's real ~/.friday/local.
//
// SAFETY: tests in a single Cargo test target run as one process with
// per-test threads. We mutate FRIDAY_LAUNCHER_HOME via std::env::set_var
// inside an env_lock-guarded section so tests don't see each other's
// env state.

#![cfg(unix)] // The shell-script stubs require a unix shell.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use studio_installer_lib::commands::migrate::migrate;

/// Serialise tests that mutate FRIDAY_LAUNCHER_HOME / HOME so parallel
/// runs within the same process don't see each other's env state.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

struct EnvGuard {
    prior_launcher: Option<String>,
}

impl EnvGuard {
    fn install(friday_home: &Path) -> Self {
        let prior_launcher = std::env::var("FRIDAY_LAUNCHER_HOME").ok();
        std::env::set_var("FRIDAY_LAUNCHER_HOME", friday_home);
        Self { prior_launcher }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prior_launcher {
            Some(v) => std::env::set_var("FRIDAY_LAUNCHER_HOME", v),
            None => std::env::remove_var("FRIDAY_LAUNCHER_HOME"),
        }
    }
}

/// Create a fake `<install_dir>/bin/friday` shell script that does
/// `body` and exits with `exit_code`. The script is made executable.
fn write_friday_stub(install_dir: &Path, body: &str, exit_code: i32) -> PathBuf {
    let bin = install_dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("friday");
    let script = format!("#!/usr/bin/env bash\n{body}\nexit {exit_code}\n");
    fs::write(&path, script).unwrap();
    let mut perms = fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&path, perms).unwrap();
    path
}

/// Layout for tests: returns a tuple (friday_home, install_dir) inside
/// a freshly-created tempdir.
fn fixture_dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let friday_home = tmp.path().join("friday-home");
    let install_dir = tmp.path().join("install");
    fs::create_dir_all(&friday_home).unwrap();
    fs::create_dir_all(&install_dir).unwrap();
    (tmp, friday_home, install_dir)
}

#[tokio::test]
async fn stub_emits_known_json_returns_parsed_outcome() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    write_friday_stub(
        &install_dir,
        r#"echo '{"preNats":[{"id":"relocate-jetstream-store","status":"noop"}],"ran":[],"skipped":[]}'"#,
        0,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    let outcome = result.expect("expected Ok outcome");
    assert_eq!(outcome.pre_nats.len(), 1);
    assert_eq!(outcome.pre_nats[0]["id"], "relocate-jetstream-store");
    assert_eq!(outcome.pre_nats[0]["status"], "noop");
}

#[tokio::test]
async fn stub_with_log_lines_before_json_finds_outcome() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    write_friday_stub(
        &install_dir,
        r#"
echo 'INFO: starting migrate'
echo '[2026-01-01] resolving paths'
echo '{"preNats":[],"ran":[],"skipped":[]}'
echo 'INFO: done'
"#,
        0,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    let outcome = result.expect("Ok outcome");
    assert!(outcome.pre_nats.is_empty());
    // `ran` and `skipped` survive in `extra` via #[serde(flatten)].
    assert!(outcome.extra.contains_key("ran"));
}

#[tokio::test]
async fn env_keys_are_forwarded_to_subprocess() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    // Seed .env with values the stub will echo back so we can inspect.
    fs::write(
        friday_home.join(".env"),
        "FRIDAY_PORT_FRIDAY=18080\nFRIDAY_JETSTREAM_STORE_DIR=/some/path\n",
    )
    .unwrap();

    // Stub: write the env var values to a sentinel file in friday_home.
    let sentinel = friday_home.join("env-sentinel");
    write_friday_stub(
        &install_dir,
        &format!(
            r#"
echo "PORT=$FRIDAY_PORT_FRIDAY" > '{sentinel}'
echo "STORE=$FRIDAY_JETSTREAM_STORE_DIR" >> '{sentinel}'
echo '{{"preNats":[]}}'
"#,
            sentinel = sentinel.display(),
        ),
        0,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    assert!(result.is_ok(), "expected Ok, got {result:?}");

    let captured = fs::read_to_string(&sentinel).expect("sentinel file");
    assert!(
        captured.contains("PORT=18080"),
        "FRIDAY_PORT_FRIDAY not forwarded; captured:\n{captured}"
    );
    assert!(
        captured.contains("STORE=/some/path"),
        "FRIDAY_JETSTREAM_STORE_DIR not forwarded; captured:\n{captured}"
    );
}

#[tokio::test]
async fn nonzero_exit_returns_err_with_stderr_tail() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    write_friday_stub(
        &install_dir,
        r#"
echo 'something went wrong' >&2
echo 'detail line' >&2
"#,
        7,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    let err = result.expect_err("expected Err on nonzero exit");
    assert!(
        err.contains("something went wrong") || err.contains("detail line"),
        "stderr tail missing in err string: {err}"
    );
}

#[tokio::test]
async fn jsonl_record_appended_on_success() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    // Logs dir does NOT exist beforehand — the command must mkdir-p.
    let log_dir = friday_home.join("logs");
    assert!(!log_dir.exists());

    write_friday_stub(
        &install_dir,
        r#"echo '{"preNats":[],"ran":[]}'"#,
        0,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    assert!(result.is_ok(), "expected Ok, got {result:?}");

    let log_path = log_dir.join("installer.log");
    assert!(log_path.exists(), "installer.log not written");

    let content = fs::read_to_string(&log_path).unwrap();
    let line = content.lines().next().expect("at least one line");
    let record: serde_json::Value =
        serde_json::from_str(line).expect("record must parse as JSON");
    assert_eq!(record["command"], "migrate");
    assert_eq!(record["exit_code"], 0);
    // outcome is a parsed JSON object on success
    assert!(
        record["outcome"].is_object(),
        "outcome should be present on success: {line}"
    );
    // stderr_tail is null on success
    assert!(record["stderr_tail"].is_null(), "stderr_tail should be null on success");
    // ts is an ISO8601-shaped string
    let ts = record["ts"].as_str().expect("ts string");
    assert!(
        ts.ends_with('Z') && ts.contains('T'),
        "ts not ISO8601-shaped: {ts}"
    );
}

#[tokio::test]
async fn jsonl_record_appended_on_failure() {
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    write_friday_stub(
        &install_dir,
        r#"
echo 'failure mode' >&2
"#,
        2,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    assert!(result.is_err(), "expected Err on nonzero exit");

    let log_path = friday_home.join("logs").join("installer.log");
    let content = fs::read_to_string(&log_path).unwrap();
    let line = content.lines().next().expect("a record");
    let record: serde_json::Value =
        serde_json::from_str(line).expect("parse record");
    assert_eq!(record["exit_code"], 2);
    assert!(
        record["outcome"].is_null(),
        "outcome should be null on failure: {line}"
    );
    let stderr_tail = record["stderr_tail"]
        .as_str()
        .expect("stderr_tail set on failure");
    assert!(
        stderr_tail.contains("failure mode"),
        "stderr_tail content unexpected: {stderr_tail}"
    );
}

#[tokio::test]
async fn locate_friday_finds_binary_under_install_dir_bin() {
    // Asserts the path-resolution invariant: the binary is found ONLY
    // when it lives at <install_dir>/bin/friday. Drop the binary at a
    // different location and the command refuses (Err with a message
    // referencing the missing binary).
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    // Place a stub at the WRONG location.
    let wrong_dir = install_dir.join("not-bin");
    fs::create_dir_all(&wrong_dir).unwrap();
    let wrong_path = wrong_dir.join("friday");
    fs::write(&wrong_path, "#!/usr/bin/env bash\nexit 0\n").unwrap();
    let mut perms = fs::metadata(&wrong_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&wrong_path, perms).unwrap();

    let result =
        migrate(install_dir.to_string_lossy().to_string()).await;
    let err = result.expect_err("should not find binary at non-bin path");
    assert!(
        err.contains("friday binary not found"),
        "unexpected err: {err}"
    );

    // Now write the stub at the CORRECT bin/friday path. It should be
    // found and the command should succeed.
    write_friday_stub(&install_dir, r#"echo '{"preNats":[]}'"#, 0);
    let result =
        migrate(install_dir.to_string_lossy().to_string()).await;
    assert!(result.is_ok(), "expected Ok with binary at bin/friday: {result:?}");
}

#[tokio::test]
async fn install_dir_bin_is_prepended_to_subprocess_path() {
    // The Tauri command must prepend `<install_dir>/bin` to PATH so the
    // spawned `friday migrate` can locate bundled binaries (especially
    // `nats-server`, which the post-NATS phase tries to spawn via
    // `findNatsServerBinary()` — a bare `which nats-server`). Without
    // this, every install hits "nats-server not found" and the migrate
    // step renders red ✗ even on a successful pre-NATS move.
    let _g = env_lock();
    let (_tmp, friday_home, install_dir) = fixture_dirs();
    let _env = EnvGuard::install(&friday_home);

    let sentinel = friday_home.join("path-sentinel");
    write_friday_stub(
        &install_dir,
        &format!(
            r#"
echo "PATH=$PATH" > '{sentinel}'
echo '{{"preNats":[]}}'
"#,
            sentinel = sentinel.display(),
        ),
        0,
    );

    let result = migrate(install_dir.to_string_lossy().to_string()).await;
    assert!(result.is_ok(), "expected Ok, got {result:?}");

    let captured = fs::read_to_string(&sentinel).expect("sentinel file");
    let expected_bin = install_dir.join("bin").display().to_string();
    let path_line = captured.trim_start_matches("PATH=").trim_end();
    // The bundled bin dir must be the FIRST entry — so a bundled
    // `nats-server` wins over any system-installed one (e.g.,
    // homebrew). `which` walks PATH left-to-right.
    assert!(
        path_line.starts_with(&expected_bin),
        "<install_dir>/bin not at the front of PATH; got:\n{path_line}\nwanted prefix: {expected_bin}"
    );
}
