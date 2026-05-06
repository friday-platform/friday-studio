// migrate — Tauri command that drives `friday migrate --json` from the
// installer wizard.
//
// What this does:
//   1. spawn `<install_dir>/bin/friday migrate --json`
//   2. capture stdout / stderr / exit code
//   3. take the last JSON-object line from stdout as the outcome
//   4. append one JSONL record to <friday_home>/logs/migrate.jsonl
//   5. return Ok(outcome) | Err(stderr_tail) to Svelte
//
// The installer is schema-agnostic. It does not know what migrations
// `friday migrate` runs, what fields they emit, or what changed
// between versions. The contract is just "the binary prints its
// outcome as a JSON object on the last non-empty line of stdout."
//
// Why a dedicated audit file: `installer.log` is already written by
// `ensure_agent_browser_chrome` with arbitrary stdout. Splitting
// per-command into `migrate.jsonl` keeps the trail jq-parseable.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::env_file::parse_env_lines;
use crate::friday_home::friday_home_dir;

#[tauri::command]
pub async fn migrate(
    install_dir: String,
) -> Result<serde_json::Value, String> {
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
        let _ = append_log_record(&friday_home, -1, None, Some(&msg));
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
    cmd.arg("migrate").arg("--json");
    for (k, v) in &env_kv {
        cmd.env(k, v);
    }
    // Pin FRIDAY_HOME explicitly. atlas-cli's getFridayHome() defaults
    // to ~/.atlas when FRIDAY_HOME is unset (deno-mode legacy), but the
    // installer writes everything under ~/.friday/local. Without this,
    // `friday migrate` would look for .env at ~/.atlas/.env, fail to
    // find it, and the daemon-alive probe + relocate-target resolution
    // would fall back to the wrong defaults. This mirrors what the
    // launcher already emits to its supervised services
    // (tools/friday-launcher/project.go's commonServiceEnv).
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

    // The contract: `friday migrate --json` prints its outcome as a JSON
    // object on the last non-empty line of stdout. We don't interpret
    // the schema — just take the last JSON-object line and forward it.
    let outcome = last_json_object_line(&stdout);

    // Always persist a JSONL record before returning. A log-write
    // failure is reported on stderr but doesn't shadow the migrate
    // outcome — the installer UI still gets the success/failure signal.
    let stderr_tail = if exit_code != 0 {
        Some(stderr_tail(&stderr))
    } else {
        None
    };
    if let Err(e) = append_log_record(
        &friday_home,
        exit_code,
        outcome.clone(),
        stderr_tail.as_deref(),
    ) {
        eprintln!("[installer] could not append migrate.jsonl record: {e}");
    }

    if exit_code == 0 {
        match outcome {
            Some(o) => Ok(o),
            None => Err(format!(
                "friday migrate exit 0 but stdout had no parseable JSON outcome line; stdout={stdout}"
            )),
        }
    } else {
        Err(stderr_tail.unwrap_or_else(|| format!("friday migrate exited {exit_code}")))
    }
}

/// Resolve the bundled friday binary inside the installer's binary
/// directory. Mirrors `locate_uv` in prewarm_agent_sdk.rs — keep in
/// sync. For a default install, `install_dir` is `~/.friday/local`
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

/// Return the last line of `stdout` that parses as a JSON object.
///
/// `friday migrate --json` may emit one or more lines on stdout (the
/// outcome itself, plus any `@atlas/logger` info-level lines that share
/// the stdout stream because Node/Deno's `console.info` goes there).
/// The producer guarantees the OUTCOME is the last JSON-object line —
/// any logger lines come earlier in execution — so a backward scan
/// reliably picks it without needing schema knowledge.
fn last_json_object_line(stdout: &str) -> Option<serde_json::Value> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if v.is_object() {
                return Some(v);
            }
        }
    }
    None
}

/// Last 8 lines of stderr, capped at 2KB total. The `min(8 lines, 2KB)`
/// rule comes from the v6 plan — the cap keeps malformed-CLI cases
/// (binary stderr, megabyte log dumps) from bloating migrate.jsonl.
fn stderr_tail(stderr: &str) -> String {
    const MAX_BYTES: usize = 2048;
    const MAX_LINES: usize = 8;

    let lines: Vec<&str> = stderr.lines().collect();
    let start = lines.len().saturating_sub(MAX_LINES);
    let tail = lines[start..].join("\n");
    if tail.len() <= MAX_BYTES {
        tail
    } else {
        // Keep the most recent bytes — this is more useful for
        // debugging than the leading bytes of the tail window.
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
/// `logs/` directory is created if absent. The record shape is fixed
/// per the v6 plan ("installer.log format" section — applies to the
/// JSONL shape regardless of which file it lands in).
///
/// Why a dedicated file instead of the shared `installer.log`:
/// `ensure_agent_browser_chrome.rs` already writes the
/// `agent-browser doctor` step's stdout to `installer.log` — including
/// noise like xcode-select prompts. Multiple writers to one file
/// caused our JSONL records to be interleaved with arbitrary text and
/// hard to parse. Splitting per-command into `migrate.jsonl` keeps
/// each tool's audit trail self-contained and `jq`-parseable.
fn append_log_record(
    friday_home: &Path,
    exit_code: i32,
    outcome: Option<serde_json::Value>,
    stderr_tail: Option<&str>,
) -> Result<(), String> {
    let log_dir = friday_home.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|e| format!("create logs dir {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join("migrate.jsonl");

    let record = serde_json::json!({
        "ts": iso8601_utc_now(),
        "command": "migrate",
        "exit_code": exit_code,
        "outcome": outcome,
        "stderr_tail": stderr_tail,
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
    fn last_json_object_line_picks_the_last_object() {
        // Mixed plain-text + JSON lines. The OUTCOME (last JSON object)
        // wins — the earlier object on line 3 is logger noise that the
        // producer emits before the real result.
        let stdout = concat!(
            "INFO: starting migrate\n",
            "[2026-01-01] something happened\n",
            "{\"level\":\"info\",\"msg\":\"resolved paths\"}\n",
            "{\"status\":\"ok\",\"streams_moved\":3}\n",
        );
        let outcome = last_json_object_line(stdout).expect("should parse");
        assert_eq!(outcome["status"], "ok");
        assert_eq!(outcome["streams_moved"], 3);
    }

    #[test]
    fn last_json_object_line_returns_none_when_no_json() {
        let stdout = "no json here\nplain logs only\n";
        assert!(last_json_object_line(stdout).is_none());
    }

    #[test]
    fn last_json_object_line_ignores_arrays_and_scalars() {
        // Top-level JSON values that aren't objects (arrays, numbers,
        // strings) are not the outcome — `migrate --json` always emits
        // an object. Reject them so a stray `[1,2,3]` line doesn't get
        // forwarded as the outcome.
        let stdout = concat!(
            "{\"status\":\"ok\"}\n",
            "[1, 2, 3]\n",
            "42\n",
            "\"a string\"\n",
        );
        let outcome = last_json_object_line(stdout).expect("should pick the object");
        assert_eq!(outcome["status"], "ok");
    }

    #[test]
    fn stderr_tail_returns_last_8_lines() {
        let lines: Vec<String> = (0..20).map(|i| format!("line-{i}")).collect();
        let stderr = lines.join("\n");
        let tail = stderr_tail(&stderr);
        // Should contain lines 12..=19, joined by \n
        assert!(tail.contains("line-12"), "tail missing line-12: {tail}");
        assert!(tail.contains("line-19"), "tail missing line-19: {tail}");
        assert!(!tail.contains("line-11"), "tail wrongly contains line-11");
    }
}
