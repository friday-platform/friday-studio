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
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::commands::platform::install_dir;

#[derive(serde::Serialize)]
pub struct AgentBrowserChromeResult {
    /// Whether we just ran a cold install (`true`) or found a cached
    /// Chrome (`false`). Used by the JS side to decide whether to
    /// surface the brief "Installing browser…" indicator.
    pub installed_now: bool,
}

#[tauri::command]
pub async fn ensure_agent_browser_chrome() -> Result<AgentBrowserChromeResult, String> {
    let install_dir_str = install_dir()?;
    let install_dir_path = PathBuf::from(install_dir_str);

    let bin_name = if cfg!(windows) {
        "agent-browser.exe"
    } else {
        "agent-browser"
    };
    let ab_bin = install_dir_path.join("bin").join(bin_name);

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
    {
        let ab_bin = ab_bin.clone();
        let home = home.clone();
        let exit = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&ab_bin);
            cmd.arg("--version");
            // Mirror ensure_claude_code's HOME-defensive spawn: when
            // launched via Spotlight/Finder the inherited env can be
            // near-empty.
            if env::var_os("HOME").is_none() {
                cmd.env("HOME", &home);
            }
            cmd.status()
        })
        .await
        .map_err(|e| format!("--version task join error: {e}"))?
        .map_err(|e| format!("agent-browser binary unrunnable: {e}"))?;

        if !exit.success() {
            return Err(format!(
                "agent-browser --version exited {}; binary may be corrupt.",
                exit.code().unwrap_or(-1)
            ));
        }
    }

    // 2. Cold-install detection: ~/.agent-browser/browsers/ exists ⇒
    //    Chrome cached. Used to gate the post-install doctor check —
    //    skipped on warm runs because Chrome's own cache-hit path is
    //    nearly always fine and `doctor` adds ~5–10s.
    let chrome_cache = home.join(".agent-browser").join("browsers");
    let cold_install = !chrome_cache.exists();

    // 3. Download Chrome for Testing (~150 MB) into ~/.agent-browser/.
    //
    //    Mirror ensure_claude_code's HOME-defensive spawn: when
    //    launched via Spotlight/Finder, the inherited env can be
    //    near-empty and agent-browser's get_browsers_dir() falls back
    //    to "." and writes Chrome to the cwd. Set HOME explicitly
    //    when missing.
    {
        let ab_bin = ab_bin.clone();
        let home = home.clone();
        let install_status = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&ab_bin);
            cmd.arg("install");
            if env::var_os("HOME").is_none() {
                cmd.env("HOME", &home);
            }
            cmd.status()
        })
        .await
        .map_err(|e| format!("install task join error: {e}"))?
        .map_err(|e| format!("agent-browser install failed: {e}"))?;

        if !install_status.success() {
            return Err(format!(
                "agent-browser install exited {}",
                install_status.code().unwrap_or(-1)
            ));
        }
    }

    // 4. Cold install only: live launch test catches macOS sandbox /
    //    Gatekeeper / entitlement issues that --version wouldn't.
    //    Failure is informational, not fatal: agent-browser is
    //    installed; only Chrome integration is broken, and some doctor
    //    failures are transient (network).
    //
    //    Output redirected to <install>/logs/installer.log so
    //    ops/debug can see *why* a later browse fails without alarming
    //    the user during install.
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
            let ab_bin = ab_bin.clone();
            let home = home.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let mut doctor = Command::new(&ab_bin);
                doctor
                    .arg("doctor")
                    .stdout(Stdio::from(log_file))
                    .stderr(log_clone.map(Stdio::from).unwrap_or_else(Stdio::null));
                if env::var_os("HOME").is_none() {
                    doctor.env("HOME", &home);
                }
                doctor.status()
            })
            .await;
        }
    }

    Ok(AgentBrowserChromeResult {
        installed_now: cold_install,
    })
}
