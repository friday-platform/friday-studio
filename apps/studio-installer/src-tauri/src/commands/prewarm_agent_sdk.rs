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
//   constant below must match. We keep them as separate constants
//   rather than reading from a shared file because the installer
//   ships independently of the launcher binary; mismatched versions
//   would just mean the launcher and installer pre-warm slightly
//   different wheels (no functional break, just one extra cold start
//   on first launcher-driven spawn).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Pinned PyPI version. MUST match
/// tools/friday-launcher/paths.go::bundledAgentSDKVersion.
const BUNDLED_AGENT_SDK_VERSION: &str = "0.1.3";

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
pub async fn prewarm_agent_sdk(install_dir: String) -> Result<PrewarmResult, String> {
    let install_path = PathBuf::from(&install_dir);
    let uv_path = locate_uv(&install_path);

    let Some(uv) = uv_path else {
        // No bundled uv. We don't fail the install — the install
        // archive layout could legitimately omit uv on some platforms
        // we add later, and the launcher's spawn-resolution falls
        // through to bare python3. Surface as "not warmed" and let
        // the JS side decide whether to flag it.
        return Ok(PrewarmResult {
            uv_path: String::new(),
            sdk_version: BUNDLED_AGENT_SDK_VERSION.to_string(),
            warmed: false,
        });
    };

    // Resolve <friday-home>/uv/{python,cache} so uv writes there
    // instead of XDG defaults. Mirrors the launcher's fridayEnv()
    // emission of UV_PYTHON_INSTALL_DIR + UV_CACHE_DIR — keep these
    // aligned or the runtime cache misses the warmed wheels.
    let friday_home = friday_home_dir()?;
    let uv_python_dir = friday_home.join("uv").join("python");
    let uv_cache_dir = friday_home.join("uv").join("cache");
    std::fs::create_dir_all(&uv_python_dir)
        .map_err(|e| format!("create UV_PYTHON_INSTALL_DIR: {e}"))?;
    std::fs::create_dir_all(&uv_cache_dir).map_err(|e| format!("create UV_CACHE_DIR: {e}"))?;

    let with_arg = format!("friday-agent-sdk=={BUNDLED_AGENT_SDK_VERSION}");

    let output = Command::new(&uv)
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
        .output()
        .map_err(|e| format!("spawn uv: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "uv pre-warm failed (status {}): {stderr}",
            output.status
        ));
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

/// Resolve the daemon's home directory (canonical: ~/.friday/local).
/// Uses the same logic as the launcher's friendlyHome() and the daemon's
/// getFridayHome() — pinned here rather than shared because the installer
/// is a separate Rust binary.
fn friday_home_dir() -> Result<PathBuf, String> {
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
}
