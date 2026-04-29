// ensure_agent_browser_chrome — verifies the bundled agent-browser
// binary runs, then downloads Chrome for Testing into the per-user
// cache (~/.agent-browser/browsers/).
//
// Why we need this:
//   Friday's `web` agent calls `execFile("agent-browser", ...)` at
//   packages/bundled-agents/src/web/tools/browse.ts:67. The launcher
//   bundles the agent-browser binary at <install>/bin/agent-browser
//   (build-studio.ts EXTERNAL_CLIS) and emits FRIDAY_AGENT_BROWSER_PATH
//   so start.tsx can augment the daemon's PATH. But the binary alone
//   can't drive a real browser — agent-browser requires a Chrome
//   for Testing install at ~/.agent-browser/browsers/chrome-<v>/
//   which its own `agent-browser install` subcommand handles.
//
// Different shape from ensure_claude_code: the binary itself is
// already on disk (bundled, extracted by runExtract). This command
// only handles the Chrome download + verifies the binary actually
// runs first.
//
// Idempotent: re-running is fast (Chrome cache hit short-circuits in
// agent-browser install's own logic at cli/src/install.rs:455-465).

use std::env;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::commands::platform::install_dir;

#[tauri::command]
pub async fn ensure_agent_browser_chrome() -> Result<(), String> {
    let install_dir_path = PathBuf::from(install_dir()?);

    let bin_name = if cfg!(windows) {
        "agent-browser.exe"
    } else {
        "agent-browser"
    };
    // Runtime tar.zst extracts binaries directly into <install>/, NOT
    // <install>/bin/. Confirmed against the launcher's own resolution
    // path at tools/friday-launcher/project.go:fridayEnv() which joins
    // the bare binary name onto binDir (which equals install_dir here).
    // Earlier shape (`install_dir.join("bin").join(...)`) silently
    // returned Err, the JS catch in Extract.svelte marked the agent-
    // browser pip ✗, and the user reached the playground without
    // Chrome — surfacing as ENOENT at first browse call.
    let ab_bin = install_dir_path.join(bin_name);

    if !ab_bin.exists() {
        // Bundling failed — runtime tar.zst didn't include it. Surface
        // clearly rather than silently no-op'ing; the user-facing
        // "browse" feature won't work either way, and a clear error
        // here saves us a bad-bundle bug report later.
        return Err(format!(
            "agent-browser binary missing at {}. Re-run the installer.",
            ab_bin.display()
        ));
    }

    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;

    // 1. Pre-flight: confirm the bundled binary actually runs. Catches
    //    binary-corruption / wrong-arch / chmod issues in ~100 ms
    //    instead of having the user sit through a ~150 MB Chrome
    //    download for a process about to crash.
    //
    //    Codifies the convention from the eval suite at
    //    tools/evals/agents/web/web.eval.ts:38-41, where the same
    //    fail-fast --version check guards eval runs.
    let version_status = run_ab(&ab_bin, &home, &["--version"], None)
        .await
        .map_err(|e| format!("agent-browser --version: {e}"))?;
    if !version_status.success() {
        return Err(format!(
            "agent-browser --version exited {}; binary may be corrupt.",
            version_status.code().unwrap_or(-1)
        ));
    }

    // 2. Cold-install detection: gates the post-install doctor check.
    //    Treat "directory missing" AND "directory empty" as cold —
    //    an interrupted prior install can leave ~/.agent-browser/browsers/
    //    present but with no usable chrome-<v>/ subdir, in which case
    //    we want doctor to run on the recovery so any sandbox /
    //    Gatekeeper / partial-extract failure surfaces in installer.log
    //    instead of silently passing.
    let chrome_cache = home.join(".agent-browser").join("browsers");
    let cold_install = is_cold_install(&chrome_cache);

    // 3. Download Chrome for Testing (~150 MB) into ~/.agent-browser/.
    //    The HOME defense is load-bearing: when launched via
    //    Spotlight/Finder, agent-browser's get_browsers_dir() falls
    //    back to "." if HOME is unset and writes Chrome to the cwd.
    let install_status = run_ab(&ab_bin, &home, &["install"], None)
        .await
        .map_err(|e| format!("agent-browser install: {e}"))?;
    if !install_status.success() {
        return Err(format!(
            "agent-browser install exited {}",
            install_status.code().unwrap_or(-1)
        ));
    }

    // 4. Cold install only: live launch test catches macOS sandbox /
    //    Gatekeeper / entitlement issues that --version wouldn't.
    //    Failure is informational, not fatal: agent-browser is
    //    installed; only Chrome integration is broken, and some doctor
    //    failures are transient (network).
    //
    //    Output redirected to <install>/logs/installer.log so ops/
    //    debug can see *why* a later browse fails without alarming
    //    the user during install. Exit code is intentionally ignored.
    if cold_install {
        let log_path = install_dir_path.join("logs").join("installer.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(log_file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let log_clone = log_file.try_clone().ok();
            let stdio = DoctorStdio {
                stdout: Stdio::from(log_file),
                stderr: log_clone.map(Stdio::from).unwrap_or_else(Stdio::null),
            };
            let _ = run_ab(&ab_bin, &home, &["doctor"], Some(stdio)).await;
        }
    }

    Ok(())
}

/// Optional stdio routing for doctor (and any future invocation that
/// needs to capture output). When `None`, the spawned child inherits
/// stdout/stderr from the parent — fine for --version (we only check
/// the exit code) and install (its progress bar is meant to be visible
/// in the wizard's launcher console / dev tools).
struct DoctorStdio {
    stdout: Stdio,
    stderr: Stdio,
}

/// Spawn the bundled agent-browser binary off the async runtime.
/// Centralizes the HOME-defensive env shim and the spawn_blocking
/// boilerplate so the body of `ensure_agent_browser_chrome` reads as
/// three logical steps (--version, install, doctor) without three
/// near-identical 12-line blocks.
async fn run_ab(
    ab_bin: &Path,
    home: &Path,
    args: &[&str],
    stdio: Option<DoctorStdio>,
) -> Result<ExitStatus, String> {
    let ab_bin = ab_bin.to_path_buf();
    let home = home.to_path_buf();
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&ab_bin);
        cmd.args(&args);
        // Mirror ensure_claude_code's HOME-defensive spawn: when launched
        // via Spotlight/Finder the inherited env can be near-empty.
        if env::var_os("HOME").is_none() {
            cmd.env("HOME", &home);
        }
        if let Some(s) = stdio {
            cmd.stdout(s.stdout).stderr(s.stderr);
        }
        cmd.status()
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
    .map_err(|e| format!("exec failed: {e}"))
}

/// `cold_install` is true when the agent-browser browsers cache is
/// missing OR present-but-empty. Treating empty as cold means an
/// interrupted prior install (where the cache dir got created but no
/// chrome-<v>/ subdir landed) re-runs the doctor check on recovery —
/// failure mode for false-warm here is silent: doctor skipped, broken
/// Chrome integration only surfaces at first browse call.
fn is_cold_install(chrome_cache: &Path) -> bool {
    if !chrome_cache.is_dir() {
        return true;
    }
    match std::fs::read_dir(chrome_cache) {
        Ok(mut entries) => entries.next().is_none(),
        // read_dir errored despite is_dir() succeeding — could be a
        // permissions race. Treat as cold so doctor runs and any real
        // problem ends up in installer.log.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::is_cold_install;
    use std::fs;

    #[test]
    fn cold_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist");
        assert!(is_cold_install(&path));
    }

    #[test]
    fn cold_when_dir_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(is_cold_install(tmp.path()));
    }

    #[test]
    fn warm_when_dir_has_a_chrome_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("chrome-148.0.7778.56")).unwrap();
        assert!(!is_cold_install(tmp.path()));
    }
}
