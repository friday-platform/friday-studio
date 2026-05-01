// prewarm_agent_sdk — materializes Python 3.12 + the pinned
// friday-agent-sdk wheel into uv's caches so the first user-agent
// spawn after install doesn't pay the ~80MB Python download + SDK
// fetch as cold-start latency.
//
// Why we run this at install time, not first spawn:
//   First-spawn cold start would surface as a 5–30s pause the very
//   first time the user creates a workspace with a Python user agent
//   — exactly the moment the user is most likely to think Friday is
//   broken. Folding the wait into the install wizard's checklist gives
//   it a "Setting up Python runtime…" indicator alongside the existing
//   Claude Code / agent-browser rows.
//
// What this calls:
//   <bin_dir>/uv run --python 3.12
//     --with friday-agent-sdk==<bundled_version>
//     python -c 'import friday_agent_sdk'
//
//   uv handles: download CPython 3.12 to UV_PYTHON_INSTALL_DIR (cached
//   forever after), fetch friday-agent-sdk from PyPI to UV_CACHE_DIR
//   (cached), build an ephemeral venv, run the import (verifies wheel
//   integrity end-to-end). On subsequent spawns, all caches hit and
//   the resolution adds ~50–100ms per run.
//
// Idempotent: re-running on a warm cache is a no-op (~200ms total).
//
// Pinned-version source-of-truth:
//   tools/friday-launcher/paths.go bundledAgentSDKVersion. The
//   constant below must match this and Dockerfile's
//   ENV FRIDAY_AGENT_SDK_VERSION. Enforced pre-merge by
//   scripts/check-sdk-pin-sync.ts (CI + lint-staged on the three pin
//   files). The runtime is still drift-tolerant — launcher re-warms
//   on first spawn if the installer pre-warmed a different version —
//   but pre-merge enforcement keeps every fresh-install user from
//   paying that 5–30s cold-start cost.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

/// Pinned PyPI version. MUST match all of:
///   - tools/friday-launcher/paths.go::bundledAgentSDKVersion
///   - Dockerfile::ENV FRIDAY_AGENT_SDK_VERSION
///
/// Enforced by scripts/check-sdk-pin-sync.ts in CI and via lint-staged
/// in the husky pre-commit hook for the three pin files.
const BUNDLED_AGENT_SDK_VERSION: &str = "0.1.5";

/// Wall-clock cap on the uv pre-warm. uv's network ops (cpython
/// download + PyPI fetch) finish in 5–30s on a healthy connection.
/// 90s gives slow-but-functional networks a chance while bounding the
/// failure mode where PyPI is unreachable (corporate proxy / captive
/// portal / DNS hang). On timeout we kill the child and surface ✗ so
/// the install proceeds; the launcher will re-warm at first agent
/// spawn (also bounded by uv's own network timeouts).
const PREWARM_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(serde::Serialize)]
pub struct PrewarmResult {
    /// Filesystem path of the uv binary used. Surfaced for debugging
    /// when the JS side wants to log "warmed via /path/to/uv".
    pub uv_path: String,
    /// Pinned SDK version that was warmed.
    pub sdk_version: String,
    /// Whether uv actually executed (`true`) or we skipped because
    /// uv wasn't bundled at this install path (`false`). Skipped
    /// pre-warm is non-fatal — the launcher's runtime resolution
    /// falls back to bare python3, and the cold-start hits the
    /// first user-agent spawn as a delay rather than as an error.
    pub warmed: bool,
}

#[tauri::command]
pub async fn prewarm_agent_sdk(
    app: AppHandle,
    install_dir: String,
) -> Result<PrewarmResult, String> {
    let install_path = PathBuf::from(&install_dir);
    let Some(uv) = locate_uv(&install_path) else {
        return Ok(PrewarmResult {
            uv_path: String::new(),
            sdk_version: BUNDLED_AGENT_SDK_VERSION.to_string(),
            warmed: false,
        });
    };

    let friday_home = friday_home_dir()?;
    let uv_python_dir = friday_home.join("uv").join("python");
    let uv_cache_dir = friday_home.join("uv").join("cache");
    std::fs::create_dir_all(&uv_python_dir)
        .map_err(|e| format!("create UV_PYTHON_INSTALL_DIR: {e}"))?;
    std::fs::create_dir_all(&uv_cache_dir).map_err(|e| format!("create UV_CACHE_DIR: {e}"))?;

    let with_arg = format!("friday-agent-sdk=={BUNDLED_AGENT_SDK_VERSION}");

    let mut child = Command::new(&uv)
        .args([
            "run",
            "--python",
            "3.12",
            "--with",
            &with_arg,
            "python",
            "-c",
            "import friday_agent_sdk",
        ])
        .env("UV_PYTHON_INSTALL_DIR", &uv_python_dir)
        .env("UV_CACHE_DIR", &uv_cache_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn uv: {e}"))?;

    // Drain both pipes concurrently so 30s of uv work shows as 30s of
    // visible activity in the UI sub-line. uv writes most progress to
    // stderr ("Resolved 14 packages in 234ms", "Installed friday-agent-
    // sdk==0.1.4"); we drain stdout too in case future uv versions
    // change that. Tasks finish naturally when pipes close on child exit.
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("prewarm:progress", line);
        }
    });
    let app_err = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("prewarm:progress", line);
        }
    });

    // Wait with timeout. On timeout, kill the child (cross-platform via
    // tokio::process::Child::kill — sends SIGKILL on unix, TerminateProcess
    // on Windows). kill_on_drop(true) above is a belt-and-suspenders for
    // panic / cancel paths.
    let status = match timeout(PREWARM_TIMEOUT, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("uv wait: {e}")),
        Err(_) => {
            let _ = child.kill().await;
            // Abort the readers so they don't emit one final
            // `prewarm:progress` event after we've already returned ✗.
            // Cosmetic — the row is already failed by the time any late
            // event fires — but tightens the mental model.
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!(
                "uv pre-warm timed out after {}s",
                PREWARM_TIMEOUT.as_secs()
            ));
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !status.success() {
        return Err(format!("uv pre-warm failed (status {status})"));
    }

    Ok(PrewarmResult {
        uv_path: uv.display().to_string(),
        sdk_version: BUNDLED_AGENT_SDK_VERSION.to_string(),
        warmed: true,
    })
}

/// Locate the bundled uv binary inside the installer's binary
/// directory. Mirrors the launcher's resolution in
/// tools/friday-launcher/project.go fridayEnv() — keep in sync.
fn locate_uv(install_dir: &Path) -> Option<PathBuf> {
    let bin_dir = install_dir.join("bin");
    let candidate = if cfg!(windows) {
        bin_dir.join("uv.exe")
    } else {
        bin_dir.join("uv")
    };
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Resolve the friday home directory exactly the way the launcher does.
/// Mirrors tools/friday-launcher/paths.go::friendlyHome() —
/// FRIDAY_LAUNCHER_HOME wins; otherwise ~/.friday/local. NO ~/.atlas
/// fallback (that's a daemon-side concern, not a launcher one).
///
/// Note: the launcher *emits* FRIDAY_HOME=<resolved> to its child
/// processes (project.go:62). We must NOT read FRIDAY_HOME here — that
/// would only ever be set inside a launcher-spawned process, never in
/// the installer's parent shell.
fn friday_home_dir() -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var("FRIDAY_LAUNCHER_HOME") {
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    let home = dirs::home_dir().ok_or("could not resolve user home dir")?;
    Ok(home.join(".friday").join("local"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_uv_finds_bin_uv() {
        let tmp = tempfile::tempdir().expect("create tmp");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
        std::fs::write(bin.join(uv_name), b"").unwrap();

        let resolved = locate_uv(tmp.path());
        assert_eq!(resolved, Some(bin.join(uv_name)));
    }

    #[test]
    fn locate_uv_returns_none_when_absent() {
        let tmp = tempfile::tempdir().expect("create tmp");
        std::fs::create_dir_all(tmp.path().join("bin")).unwrap();
        assert_eq!(locate_uv(tmp.path()), None);
    }

    #[test]
    fn friday_home_honors_launcher_env_override() {
        let tmp = tempfile::tempdir().expect("create tmp");
        let override_path = tmp.path().to_path_buf();

        // Snapshot + restore the env var to avoid leaking state to other
        // tests if cargo test runs them in parallel within the same process.
        let prior = std::env::var("FRIDAY_LAUNCHER_HOME").ok();
        std::env::set_var("FRIDAY_LAUNCHER_HOME", &override_path);

        assert_eq!(friday_home_dir().unwrap(), override_path);

        match prior {
            Some(v) => std::env::set_var("FRIDAY_LAUNCHER_HOME", v),
            None => std::env::remove_var("FRIDAY_LAUNCHER_HOME"),
        }
    }
}
