// migrate — Tauri command that drives `friday migrate` from the
// installer wizard.
//
// What this does:
//   1. spawn `<install_dir>/bin/friday migrate`
//   2. capture stdout / stderr / exit code
//   3. append a JSONL record (raw stdout + stderr + exit code) to
//      <friday_home>/logs/migrate.jsonl
//   4. return Ok(()) on exit 0; Err(stderr_tail) otherwise
//
// The installer does not parse, interpret, or shape-check the binary's
// output. The contract is just "exit code 0 means success" — the rest
// is opaque support telemetry that lives in the audit log for later
// inspection.
//
// Why a dedicated audit file: `installer.log` is already written by
// `ensure_agent_browser_chrome` with arbitrary stdout. Splitting
// per-command into `migrate.jsonl` keeps the trail self-contained.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::env_file::parse_env_lines;
use crate::friday_home::friday_home_dir;

#[tauri::command]
pub async fn migrate(install_dir: String) -> Result<(), String> {
    let install_path = PathBuf::from(&install_dir);
    let friday_home = friday_home_dir()?;

    let Some(friday_bin) = locate_friday(&install_path) else {
        // Without the binary we can't run anything. Persist a JSONL
        // record (exit_code = -1 sentinel) so the support log still
        // reflects the attempt, then bubble up an error string for
        // the Svelte red ✗ row.
        let msg = format!(
            "friday binary not found under {} (expected at bin/friday)",
            install_path.display()
        );
        let _ = append_log_record(&friday_home, -1, "", &msg);
        return Err(msg);
    };

    // Load .env keys into a map. Verbatim values to match env_file's
    // writer semantics — see parse_env_lines doc comment in env_file.rs.
    let env_path = friday_home.join(".env");
    let env_kv = match fs::read_to_string(&env_path) {
        Ok(c) => env_keys_from(&c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(e) => {
            return Err(format!("read .env at {}: {e}", env_path.display()));
        }
    };

    // Build the spawn. tokio::process::Command lets us await the child;
    // status, stdout, stderr all captured in the Output struct.
    let mut cmd = tokio::process::Command::new(&friday_bin);
    cmd.arg("migrate");
    for (k, v) in &env_kv {
        cmd.env(k, v);
    }
    // Pin FRIDAY_HOME explicitly. atlas-cli's getFridayHome() defaults
    // to ~/.atlas when FRIDAY_HOME is unset (deno-mode legacy), but the
    // installer writes everything under ~/.friday/local. Without this,
    // `friday migrate` would look for .env at ~/.atlas/.env, fail to
    // find it, and the daemon-alive probe + relocate-target resolution
    // would fall back to the wrong defaults.
    cmd.env("FRIDAY_HOME", &friday_home);
    // Defensive HOME — `friday migrate` (and its dependencies) often
    // resolve config relative to $HOME. If the wizard's parent shell
    // didn't set HOME, fall back to the resolved friday-home parent.
    if std::env::var_os("HOME").is_none() && !env_kv.contains_key("HOME") {
        if let Some(home) = dirs::home_dir() {
            cmd.env("HOME", home);
        }
    }
    // Prepend `<install_dir>/bin` to PATH so the spawned `friday migrate`
    // can locate any bundled binaries it may shell out to (notably
    // `nats-server`). The Tauri app's parent shell typically has
    // `/usr/bin:/bin` etc. on PATH but NOT the freshly-extracted
    // `<install_dir>/bin`, so without this the migrate step would render
    // red ✗ on what should be a successful run. Mirrors the launcher's
    // own PATH augmentation in tools/friday-launcher/project.go.
    let bin_dir = install_path.join("bin");
    let existing_path = env_kv
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let new_path = if existing_path.is_empty() {
        bin_dir.display().to_string()
    } else {
        format!("{}:{existing_path}", bin_dir.display())
    };
    cmd.env("PATH", new_path);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn {}: {e}", friday_bin.display()))?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    // Persist the run record. A log-write failure is reported on stderr
    // but doesn't shadow the migrate outcome — the installer UI still
    // gets the success/failure signal via the exit code.
    if let Err(e) = append_log_record(&friday_home, exit_code, &stdout, &stderr) {
        eprintln!("[installer] could not append migrate.jsonl record: {e}");
    }

    if exit_code == 0 {
        Ok(())
    } else {
        Err(if stderr.trim().is_empty() {
            format!("friday migrate exited {exit_code}")
        } else {
            tail(&stderr)
        })
    }
}

/// Resolve the bundled friday binary inside the installer's binary
/// directory. For a default install, `install_dir` is `~/.friday/local`
/// and the binary resolves to `~/.friday/local/bin/friday`.
fn locate_friday(install_dir: &Path) -> Option<PathBuf> {
    let bin_dir = install_dir.join("bin");
    let candidate = if cfg!(windows) {
        bin_dir.join("friday.exe")
    } else {
        bin_dir.join("friday")
    };
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Reduce a `.env` content blob to the (key, value) entries that
/// represent real exports. Comments and blank lines are filtered.
fn env_keys_from(content: &str) -> HashMap<String, String> {
    parse_env_lines(content)
        .into_iter()
        .filter_map(|(k, v)| k.map(|key| (key, v)))
        .collect()
}

/// Last 8 lines of `s`, capped at 2KB total. Used for both stdout and
/// stderr — keeps malformed-CLI cases (binary output, megabyte log
/// dumps) from bloating migrate.jsonl while preserving the most-recent
/// content (the part that's usually diagnostically useful).
fn tail(s: &str) -> String {
    const MAX_BYTES: usize = 2048;
    const MAX_LINES: usize = 8;

    let lines: Vec<&str> = s.lines().collect();
    let start_line = lines.len().saturating_sub(MAX_LINES);
    let tail = lines[start_line..].join("\n");
    if tail.len() <= MAX_BYTES {
        tail
    } else {
        let cut = tail.len() - MAX_BYTES;
        // Char-boundary safe: scan forward to the next valid boundary.
        let mut start = cut;
        while !tail.is_char_boundary(start) && start < tail.len() {
            start += 1;
        }
        tail[start..].to_string()
    }
}

/// Append one JSONL record to `<friday_home>/logs/migrate.jsonl`. The
/// `logs/` directory is created if absent. Stdout and stderr are
/// truncated via `tail()` so a misbehaved binary can't bloat the file.
fn append_log_record(
    friday_home: &Path,
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<(), String> {
    let log_dir = friday_home.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|e| format!("create logs dir {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join("migrate.jsonl");

    let record = serde_json::json!({
        "ts": iso8601_utc_now(),
        "command": "migrate",
        "exit_code": exit_code,
        "stdout": tail(stdout),
        "stderr": tail(stderr),
    });
    let mut line = serde_json::to_string(&record)
        .map_err(|e| format!("serialise log record: {e}"))?;
    line.push('\n');

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open {}: {e}", log_path.display()))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append {}: {e}", log_path.display()))?;
    Ok(())
}

/// Format a SystemTime::now() as ISO 8601 UTC: `YYYY-MM-DDTHH:MM:SSZ`.
/// Roll-our-own to avoid pulling chrono in as a new dep — the format is
/// trivial and we only need second precision for the support audit log.
fn iso8601_utc_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix_seconds_utc(now)
}

/// Convert a Unix timestamp (UTC seconds since epoch) to
/// `YYYY-MM-DDTHH:MM:SSZ`. Pure date arithmetic, no deps.
fn format_unix_seconds_utc(secs: u64) -> String {
    // Civil-from-days algorithm: Howard Hinnant's "date.h"
    // (https://howardhinnant.github.io/date_algorithms.html).
    // Fast, correct for all dates after the Unix epoch, no leap
    // tables.
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let h = secs_of_day / 3_600;
    let m = (secs_of_day % 3_600) / 60;
    let s = secs_of_day % 60;

    // days since 1970-01-01 -> civil date
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m_civ = if mp < 10 { mp + 3 } else { mp.wrapping_sub(9) };
    let year = if m_civ <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m_civ, d, h, m, s
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_format_known_epoch() {
        // 0 → 1970-01-01T00:00:00Z
        assert_eq!(format_unix_seconds_utc(0), "1970-01-01T00:00:00Z");
        // 1_700_000_000 → 2023-11-14T22:13:20Z (verified externally).
        assert_eq!(
            format_unix_seconds_utc(1_700_000_000),
            "2023-11-14T22:13:20Z"
        );
    }

    #[test]
    fn locate_friday_finds_bin_friday() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "friday.exe" } else { "friday" };
        fs::write(bin.join(name), b"").unwrap();

        let resolved = locate_friday(tmp.path());
        assert_eq!(resolved, Some(bin.join(name)));
    }

    #[test]
    fn locate_friday_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("bin")).unwrap();
        assert_eq!(locate_friday(tmp.path()), None);
    }

    #[test]
    fn tail_returns_last_8_lines() {
        let s: String = (0..20)
            .map(|i| format!("line-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let t = tail(&s);
        // Should contain lines 12..=19, joined by \n.
        assert!(t.contains("line-12"), "tail missing line-12: {t}");
        assert!(t.contains("line-19"), "tail missing line-19: {t}");
        assert!(!t.contains("line-11"), "tail wrongly contains line-11");
    }

    #[test]
    fn tail_caps_at_2kb() {
        // 8 lines, each ~400 chars → 3.2KB → must be truncated to ~2KB.
        let s: String = (0..8)
            .map(|i| format!("line-{i}-{}", "x".repeat(400)))
            .collect::<Vec<_>>()
            .join("\n");
        let t = tail(&s);
        assert!(t.len() <= 2048, "tail not capped: {} bytes", t.len());
    }
}
