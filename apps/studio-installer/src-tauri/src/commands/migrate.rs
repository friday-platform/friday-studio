// migrate — Tauri command that drives `friday migrate
// --json` from the installer wizard.
//
// Why this exists:
//   The installer needs to relocate JetStream data from the legacy
//   $TMPDIR/nats/jetstream path (where macOS's TMPDIR rotation silently
//   garbage-collects it) to the canonical <friday_home>/jetstream path
//   before the launcher boots. The migration logic itself lives in
//   atlas-cli (TypeScript); this command is a thin Tauri wrapper that
//   shells out to the friday binary, captures stdout/stderr, finds the
//   JSON outcome line, and persists a JSONL audit record.
//
// Trust contract:
//   - No business logic. This is a shallow wrapper at the Tauri ↔
//     Go-binary boundary that earns its keep because Svelte cannot
//     shell out directly.
//   - Stdout parsing is tolerant: log lines on stdout don't break the
//     JSON outcome discovery (defense in depth — the producer is
//     supposed to keep logs on stderr, but we don't trust it).
//   - The JSONL record is durably persisted to <friday_home>/logs/
//     migrate.jsonl on every invocation, regardless of outcome. The
//     command creates `logs/` if absent. Dedicated per-command file
//     so it doesn't collide with `installer.log` (which the
//     agent-browser-chrome step already writes to with arbitrary
//     stdout, making mixed parsing painful).

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::env_file::parse_env_lines;
use crate::friday_home::friday_home_dir;

/// Outcome shape returned to Svelte. Matches the top-level JSON object
/// emitted by `friday migrate --json`. The pre-NATS portion is strongly
/// typed; the post-NATS portion is kept loose with `serde_json::Value`
/// so future schema additions in atlas-cli don't break the Tauri
/// boundary.
///
/// `pre_nats` is `Option<Vec>` rather than `Vec` with `default` so
/// `find_outcome_line` can distinguish a real outcome JSON (which
/// always emits `preNats: [...]`, possibly empty) from a stray
/// logger-formatted line on stdout. See the `find_outcome_line` doc
/// comment for the @atlas/logger info-on-stdout backstory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationOutcome {
    /// One element per registered pre-NATS migration entry. The CLI's
    /// `--json` output always includes this field (possibly as `[]`);
    /// `None` here means the source line lacked the field entirely
    /// — typically a logger line that happens to also be JSON.
    #[serde(rename = "preNats", skip_serializing_if = "Option::is_none")]
    pub pre_nats: Option<Vec<serde_json::Value>>,
    /// Everything else the CLI emits (post-NATS `ran`, `skipped`,
    /// `failed`, etc.). We preserve unknown fields so atlas-cli can
    /// extend the schema without coordination with this Stream.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[tauri::command]
pub async fn migrate(
    install_dir: String,
) -> Result<MigrationOutcome, String> {
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
    // can locate the bundled `nats-server` (and any other in-bundle
    // binaries it may shell out to). At install time, no daemon is up
    // and the post-NATS phase needs to spawn an ephemeral nats-server
    // via packages/jetstream's `findNatsServerBinary()`, which does a
    // bare `which nats-server`. The Tauri app's parent shell typically
    // has `/usr/bin:/bin` etc. on PATH but NOT the freshly-extracted
    // `<install_dir>/bin`, so without this, every install would hit
    // the "nats-server not found, brew install nats-server" error and
    // the migrate row would render red ✗ even on a successful pre-NATS
    // move. Mirrors the launcher's own PATH augmentation in
    // tools/friday-launcher/project.go.
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

    // Tolerant stdout parsing — find the first line that parses as our
    // expected outcome shape. Leaked log lines (anything that isn't
    // valid JSON of the right shape) are skipped silently.
    let outcome = find_outcome_line(&stdout);

    // Always persist a JSONL record before returning. Failure to write
    // the log is logged but doesn't shadow the migrate outcome — the
    // installer UI still gets the success/failure signal.
    let stderr_tail = if exit_code != 0 {
        Some(stderr_tail(&stderr))
    } else {
        None
    };
    let outcome_for_log = outcome
        .as_ref()
        .and_then(|o| serde_json::to_value(o).ok());
    if let Err(e) = append_log_record(
        &friday_home,
        exit_code,
        outcome_for_log,
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

/// Search stdout for the first line that successfully parses as the
/// real `friday migrate --json` outcome shape (NOT a stray log line
/// that happens to also be JSON). Returns None if no line matches.
///
/// Why the shape check matters: `@atlas/logger` writes `info`-level
/// records with `console.info(...)`, which in Node.js / Deno goes to
/// **stdout**, not stderr (only `console.error` and `console.warn`
/// hit stderr). The `friday migrate` CLI's pre-NATS step emits a
/// resolved-paths log line on stdout for that reason. Without this
/// shape check, the parser would match the logger line first
/// (because of `serde(flatten)` swallowing `timestamp`/`level`/etc.
/// into `extra`) and the audit JSONL would record logger gunk
/// instead of the real outcome.
///
/// We require the line to carry at least one of the documented
/// outcome fields: `preNats` (pre-NATS array), or one of `ran`/
/// `skipped`/`failed` (the post-NATS arrays from `runMigrations`).
/// A logger line has none of these, so it gets skipped.
fn find_outcome_line(stdout: &str) -> Option<MigrationOutcome> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(o) = serde_json::from_str::<MigrationOutcome>(trimmed) else {
            continue;
        };
        // Reject lines that parsed only because `serde(flatten)` is
        // permissive. The real outcome always emits `preNats` (even
        // as `[]`) plus the post-NATS arrays.
        let has_outcome_field = o.pre_nats.is_some()
            || o.extra.contains_key("ran")
            || o.extra.contains_key("skipped")
            || o.extra.contains_key("failed");
        if has_outcome_field {
            return Some(o);
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
    fn find_outcome_line_skips_non_json() {
        let stdout = concat!(
            "INFO: starting migrate\n",
            "[2026-01-01] something happened\n",
            "{\"preNats\":[],\"ran\":[]}\n",
            "INFO: done\n",
        );
        let outcome = find_outcome_line(stdout).expect("should parse");
        assert_eq!(outcome.pre_nats.as_deref(), Some(&[][..]));
        assert!(outcome.extra.contains_key("ran"));
    }

    #[test]
    fn find_outcome_line_returns_none_when_no_json() {
        let stdout = "no json here\nplain logs only\n";
        assert!(find_outcome_line(stdout).is_none());
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
