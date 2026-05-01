// ensure_claude_code — verifies a Claude Code binary is installed,
// auto-installing via Anthropic's official script if not.
//
// Why we need this:
//   The deno-compiled friday daemon doesn't bundle the platform-
//   specific @anthropic-ai/claude-agent-sdk-darwin-arm64 / -windows-
//   x64 native package, so the SDK calls into a `claude` binary it
//   expects on disk. The launcher's fridayEnv() in
//   tools/friday-launcher/project.go discovers `claude` at startup
//   and threads it through as FRIDAY_CLAUDE_PATH — but that
//   discovery only succeeds if the binary is *already* on the
//   user's machine. Most fresh installs don't have claude yet.
//
// We run Anthropic's published install script
// (https://claude.ai/install.sh on Unix, install.ps1 on Windows)
// inline during the wizard so a working claude is sitting at
// ~/.local/bin/claude (or the Windows equivalent) by the time the
// launcher spawns friday.
//
// Idempotent: if a discoverable claude already exists, we skip the
// network call entirely. Re-running on the same machine never
// upgrades behind the user's back.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const INSTALL_SCRIPT_UNIX: &str = "curl -fsSL https://claude.ai/install.sh | bash";
const INSTALL_SCRIPT_WINDOWS: &str = "irm https://claude.ai/install.ps1 | iex";

#[derive(serde::Serialize)]
pub struct ClaudeInstallResult {
    /// Filesystem path of the resolved claude binary.
    pub path: String,
    /// Whether we ran the install script (`true`) or found an
    /// existing install (`false`). Used by the JS side to decide
    /// whether to surface the brief "Installing Claude Code…"
    /// indicator.
    pub installed_now: bool,
}

#[tauri::command]
pub async fn ensure_claude_code() -> Result<ClaudeInstallResult, String> {
    // 1. If claude is already discoverable, return its path. Don't
    //    upgrade silently — users running pinned versions deserve
    //    to keep them.
    if let Some(path) = discover_claude() {
        return Ok(ClaudeInstallResult {
            path: path.display().to_string(),
            installed_now: false,
        });
    }

    // 2. Fetch + run the platform-appropriate install script. Both
    //    scripts land claude at ~/.local/bin/claude (Unix) or
    //    %USERPROFILE%\.local\bin\claude.exe (Windows) per Anthropic's
    //    docs.
    run_install_script().await?;

    // 3. Re-probe. If the script "succeeded" but we still can't find
    //    claude, surface that — a silent failure here would manifest
    //    as the original SDK "binary not found" error at first agent
    //    run, which is much harder to diagnose.
    match discover_claude() {
        Some(path) => Ok(ClaudeInstallResult {
            path: path.display().to_string(),
            installed_now: true,
        }),
        None => Err(
            "Claude Code install script ran but the binary was not found afterwards. \
             Try installing manually: \
             curl -fsSL https://claude.ai/install.sh | bash"
                .into(),
        ),
    }
}

/// Find an existing claude binary at any of the canonical locations.
/// Mirrors the launcher's discoverClaudeBinary() in
/// tools/friday-launcher/project.go — keep them in sync if either
/// changes, otherwise the wizard could "succeed" without the
/// launcher being able to use the result.
fn discover_claude() -> Option<PathBuf> {
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local").join("bin").join("claude"),
        home.join(".claude").join("local").join("claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    for c in candidates {
        if is_runnable_file(&c) {
            return Some(c);
        }
    }
    None
}

fn is_runnable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() || m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Run the platform-appropriate Claude Code install script and wait
/// for it to finish. Bubbles up a useful error string if the
/// subprocess exits non-zero or can't even spawn (no curl, no
/// PowerShell, no network, etc.).
async fn run_install_script() -> Result<(), String> {
    // Inherit a sane PATH for the subprocess. macOS launches via
    // Finder/Spotlight inherit the minimal /usr/bin:/bin path; on
    // those, `curl` is fine but `~/.local/bin` (where the install
    // script chains to its own helpers) might not be.
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", INSTALL_SCRIPT_WINDOWS]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", INSTALL_SCRIPT_UNIX]);
        c
    };

    // Make sure HOME is set — Anthropic's installer writes to
    // $HOME/.local. Tauri inherits the parent env so this should
    // already be present, but defensively populate it from
    // dirs::home_dir() if not.
    if env::var_os("HOME").is_none() {
        if let Some(h) = dirs::home_dir() {
            cmd.env("HOME", h);
        }
    }

    // Run synchronously (we want the wizard to wait until the
    // install finishes). spawn_blocking keeps the Tauri runtime
    // happy on the async command boundary.
    let output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("install task join error: {e}"))?
        .map_err(|e| format!("could not run claude install script: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Stitch stderr + tail of stdout so the JS-side error toast
        // has enough context for the user / support to act on. Tail
        // because the install script's stdout is verbose progress
        // output; the final lines almost always carry the failure
        // signature.
        let tail = stdout.lines().rev().take(8).collect::<Vec<_>>();
        let tail_str = tail.iter().rev().copied().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "claude install script exited with {}: {}\n--- last stdout lines ---\n{}",
            output.status,
            stderr.trim(),
            tail_str
        ));
    }
    Ok(())
}
