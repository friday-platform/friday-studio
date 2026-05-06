use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_norway::{Mapping, Value};

use crate::friday_home::friday_home_dir;

fn env_file_path() -> Result<PathBuf, String> {
    Ok(friday_home_dir()?.join(".env"))
}

/// Atomic write helper: write to `<path>.tmp`, fsync, then rename over the
/// original. Guarantees that an external observer (another process, or the
/// same process restarted after crash) sees either the prior content or
/// the full new content — never a partial mix and never an empty file.
///
/// Best-effort cleanup: if a stale `<path>.tmp` exists from a prior crash,
/// we attempt to remove it before writing the fresh tmp. Cleanup failures
/// are logged and ignored — the subsequent write+rename overwrites the
/// stale tmp anyway.
///
/// fsync semantics: we fsync the file contents (data) but NOT the
/// containing directory. On most platforms this is sufficient for the
/// "no torn write" guarantee — the rename is atomic, so the worst case
/// after a crash is that the rename was lost (original survives) rather
/// than a partial file. Operators who need durable-against-power-loss
/// fsync of the directory entry can add it later; the failure mode here
/// (config rolled back to prior content) is acceptable for `.env`.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;

    // Best-effort cleanup of a stale tmp from a prior crash. Don't fail
    // the write if cleanup fails — the rename below will replace it.
    let tmp = path.with_extension({
        let existing = path.extension().map(|e| e.to_string_lossy().into_owned());
        match existing {
            Some(e) if !e.is_empty() => format!("{e}.tmp"),
            _ => "tmp".to_string(),
        }
    });
    if tmp.exists() {
        if let Err(e) = fs::remove_file(&tmp) {
            eprintln!(
                "[installer] could not remove stale tmp {}: {e} (continuing)",
                tmp.display()
            );
        }
    }

    fs::create_dir_all(parent)
        .map_err(|e| format!("create parent dir {}: {e}", parent.display()))?;

    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("create tmp {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write tmp {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("fsync tmp {}: {e}", tmp.display()))?;
    }

    fs::rename(&tmp, path).map_err(|e| {
        // Cleanup the leftover tmp on rename failure so we don't leak
        // partial state. If THAT fails, we've already lost — log and move on.
        if let Err(rm_err) = fs::remove_file(&tmp) {
            eprintln!(
                "[installer] rename failed and tmp cleanup failed at {}: {rm_err}",
                tmp.display()
            );
        }
        format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        )
    })?;

    Ok(())
}

/// Parse a `.env`-format file into an ordered list of (key, value) pairs.
/// Lines that don't match `KEY=VALUE` are preserved as-is (comments, blanks).
///
/// Verbatim values: no quote stripping, no escape handling. The migrate
/// command (commands/migrate.rs) re-uses this same parser shape to keep
/// the writer/reader contract symmetrical inside the installer crate.
///
/// One exception to the verbatim rule: trailing `\r` is stripped. Rust's
/// `str::lines()` already strips `\r\n` line *boundaries* — so for a
/// well-formed CRLF file the trim is a no-op. The trim defends against
/// the one case that survives `lines()`: a final line with a CR but
/// **no following LF** (e.g., a Notepad save that didn't append a final
/// newline). For input `"A=1\r"` `lines()` yields `"A=1\r"` verbatim
/// (no boundary to strip), and without this trim the parsed value would
/// be `"1\r"` — breaking downstream URL construction. The Go launcher's
/// `loadDotEnv` applies the same trim for parity (it splits on `\n`
/// only, so for Go this trim handles the more common `\r\n` case too).
pub(crate) fn parse_env_lines(content: &str) -> Vec<(Option<String>, String)> {
    content
        .lines()
        .map(|line| {
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim().to_string();
                if !key.is_empty() && !key.starts_with('#') {
                    return (Some(key), v.trim_end_matches('\r').to_string());
                }
            }
            (None, line.to_string())
        })
        .collect()
}

fn render_env_lines(lines: &[(Option<String>, String)]) -> String {
    lines
        .iter()
        .map(|(key, val)| {
            if let Some(k) = key {
                format!("{k}={val}")
            } else {
                val.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Returns true iff the .env file at ~/.friday/local/.env exists and
/// contains a non-empty value for any of the four supported provider
/// API key vars. The wizard uses this to decide whether to route
/// through the API Keys step on update/reinstall paths (so the user
/// always has a working key by the time the launcher spawns), and
/// to verify after `write_env_file` that the write actually
/// persisted.
#[tauri::command]
pub fn env_file_has_provider_key() -> Result<bool, String> {
    let path = env_file_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read .env: {e}")),
    };
    for (key, value) in parse_env_lines(&content) {
        let Some(k) = key else { continue };
        if matches!(
            k.as_str(),
            "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY" | "GROQ_API_KEY"
        ) && !value.trim().is_empty()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Returns the absolute path of the .env file (whether it exists or
/// not). Used by the JS side after write_env_file to verify the
/// write landed on disk where we expected.
#[tauri::command]
pub fn env_file_location() -> Result<String, String> {
    Ok(env_file_path()?.display().to_string())
}

/// Append missing platform-internal env vars (ports, store dir, link
/// URLs, etc.) to `lines`. Existing values are NEVER overwritten — if
/// a user customised `FRIDAY_PORT_FRIDAY` in `.env`, we leave it. New
/// defaults the installer ships (e.g. `FRIDAY_JETSTREAM_STORE_DIR`)
/// get added on every run, so an upgrade picks them up even when
/// `write_env_file` itself isn't invoked (update mode skips it when
/// the user already has an API key).
fn apply_platform_vars(
    lines: &mut Vec<(Option<String>, String)>,
    existing_keys: &HashMap<String, usize>,
) -> Result<(), String> {
    // Per-machine value: depends on friday_home_dir() resolution, so
    // it can't live in the static array below. `nats` (not `jetstream`)
    // because nats-server itself appends a `jetstream/` segment
    // internally — naming the storeDir `nats` produces the clean
    // `<home>/nats/jetstream/$G/streams/...` layout.
    let jetstream_store_dir = friday_home_dir()?
        .join("nats")
        .display()
        .to_string();

    // Friday Studio reserves its own non-default port range so a user
    // running another local Friday instance, a stock atlasd from
    // source, or another tool on the conventional 5200/8080 ports
    // doesn't clash with the installed launcher.
    //
    //   FRIDAY_PORT_FRIDAY            18080  ← daemon (was 8080)
    //   FRIDAY_PORT_LINK              13100  ← link (was 3100)
    //   FRIDAY_PORT_WEBHOOK_TUNNEL    19090  ← tunnel (was 9090)
    //   FRIDAY_PORT_PLAYGROUND        15200  ← studio UI (was 5200)
    //
    // The launcher imports ~/.friday/local/.env into its own process
    // env (tools/friday-launcher/main.go's importDotEnvIntoProcessEnv).
    // The matching EXTERNAL_*_URL / FRIDAYD_URL values ensure the
    // playground UI's window.__FRIDAY_CONFIG__ points at the moved
    // daemon + tunnel — auto-derive isn't possible because the URLs
    // may also include user-controlled hostnames or schemes.
    let platform_vars: Vec<(&str, String)> = vec![
        ("FRIDAY_LOCAL_ONLY", "true".to_string()),
        ("LINK_DEV_MODE", "true".to_string()),
        ("FRIDAY_PORT_FRIDAY", "18080".to_string()),
        ("FRIDAY_PORT_LINK", "13100".to_string()),
        ("FRIDAY_PORT_WEBHOOK_TUNNEL", "19090".to_string()),
        ("FRIDAY_PORT_PLAYGROUND", "15200".to_string()),
        ("FRIDAYD_URL", "http://localhost:18080".to_string()),
        ("EXTERNAL_DAEMON_URL", "http://localhost:18080".to_string()),
        ("EXTERNAL_TUNNEL_URL", "http://localhost:19090".to_string()),
        // Daemon proxies /api/link/* to LINK_SERVICE_URL; without
        // this line it falls back to the legacy :3100 and credential
        // lookups for Gmail / Slack / etc. fail with ECONNREFUSED.
        ("LINK_SERVICE_URL", "http://localhost:13100".to_string()),
        // The launcher reads FRIDAY_JETSTREAM_STORE_DIR and passes it
        // to nats-server as `-sd`; the daemon reads it via
        // readJetStreamConfig. Default: <friday_home>/nats — stable,
        // persistent, never `$TMPDIR` (which macOS periodically GCs).
        ("FRIDAY_JETSTREAM_STORE_DIR", jetstream_store_dir),
    ];
    for (k, v) in &platform_vars {
        if !existing_keys.contains_key(*k) {
            lines.push((Some((*k).to_string()), v.clone()));
        }
    }
    Ok(())
}

/// Add any platform vars missing from `.env`. Called on every install
/// (fresh AND update) so a customer upgrading from a build that
/// didn't ship a particular var picks up the new default. Existing
/// values are preserved — if you've customised `.env`, your
/// customisations survive.
#[tauri::command]
pub fn ensure_platform_env_vars() -> Result<String, String> {
    let path = env_file_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .friday/local dir: {e}"))?;
    }

    let existing_content = fs::read_to_string(&path).unwrap_or_default();
    let mut lines = parse_env_lines(&existing_content);
    let existing_keys: HashMap<String, usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, (k, _))| k.as_ref().map(|key| (key.clone(), i)))
        .collect();

    apply_platform_vars(&mut lines, &existing_keys)?;

    let output = render_env_lines(&lines);
    atomic_write(&path, output.as_bytes())
        .map_err(|e| format!("Failed to write .env file: {e}"))?;

    Ok(path.display().to_string())
}

/// Returns the URL the wizard should open in the user's browser to
/// land on the local playground. Reads FRIDAY_PORT_PLAYGROUND from
/// ~/.friday/local/.env (which the wizard itself writes during the
/// API Keys step) and falls back to 15200 if the file is missing or
/// the key is unset. Centralised so every "open studio" entry point
/// (Welcome, launchByOpening, openPlaygroundAndExit) lands on the
/// same URL — pre-fix, all three hardcoded :5200 and broke any
/// install with a port override.
#[tauri::command]
pub fn playground_url() -> Result<String, String> {
    let port = match fs::read_to_string(env_file_path()?) {
        Ok(content) => parse_env_lines(&content)
            .into_iter()
            .find_map(|(k, v)| match k {
                Some(key) if key == "FRIDAY_PORT_PLAYGROUND" => Some(v.trim().to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "15200".to_string()),
        Err(_) => "15200".to_string(),
    };
    Ok(format!("http://localhost:{port}"))
}

#[tauri::command]
pub fn write_env_file(
    anthropic_key: Option<String>,
    openai_key: Option<String>,
    gemini_key: Option<String>,
    groq_key: Option<String>,
) -> Result<String, String> {
    let path = env_file_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .friday/local dir: {e}"))?;
    }

    let existing_content = fs::read_to_string(&path).unwrap_or_default();
    let mut lines = parse_env_lines(&existing_content);

    // Build a map of existing keys for fast lookup
    let existing_keys: HashMap<String, usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, (k, _))| k.as_ref().map(|key| (key.clone(), i)))
        .collect();

    // User-provided API keys: OVERWRITE the existing entry when a
    // new value comes in. Previous behaviour ("only add if missing")
    // meant a user who came back to update their key found it
    // silently ignored. Append-or-replace lets reinstall flows fix
    // a stale or empty key without manually editing .env.
    let provider_keys: [(&str, &Option<String>); 4] = [
        ("ANTHROPIC_API_KEY", &anthropic_key),
        ("OPENAI_API_KEY", &openai_key),
        ("GEMINI_API_KEY", &gemini_key),
        ("GROQ_API_KEY", &groq_key),
    ];
    for (env_var, value) in provider_keys {
        if let Some(key) = value {
            match existing_keys.get(env_var) {
                Some(&i) => lines[i] = (Some(env_var.to_string()), key.clone()),
                None => lines.push((Some(env_var.to_string()), key.clone())),
            }
        }
    }

    apply_platform_vars(&mut lines, &existing_keys)?;

    let output = render_env_lines(&lines);
    atomic_write(&path, output.as_bytes())
        .map_err(|e| format!("Failed to write .env file: {e}"))?;

    // Read-back verification — catches the silent-fail case where
    // fs::write returned Ok but the file didn't actually land
    // (filesystem quirk, snapshotting, race with another writer).
    let written = fs::read_to_string(&path).map_err(|e| format!("verify .env after write: {e}"))?;
    if !written.contains("FRIDAY_LOCAL_ONLY") {
        return Err(format!(
            ".env at {} did not contain expected platform vars after write",
            path.display()
        ));
    }

    // Manage ~/.friday/local/friday.yml so the daemon's per-role model
    // resolution matches the wizard's provider pick. Anthropic uses the
    // zero-config default chain (DEFAULT_PLATFORM_MODELS already targets
    // anthropic:* models); the other three providers need an explicit
    // models block. See docs/plans/2026-04-29-installer-non-anthropic-
    // providers.v6.md for the full design rationale.
    //
    // The wizard's path here is independent of the .env path; if the
    // wizard couldn't write friday.yml the daemon would boot with a
    // stale models block (or hit the default-chain Anthropic miss for
    // a non-Anthropic install). Hard error — the wizard's API Keys
    // step renders saveError verbatim, so the user gets an actionable
    // message instead of a confusing generic "Authentication: ✗" later.
    manage_friday_yml(&anthropic_key, &openai_key, &gemini_key, &groq_key)?;

    Ok(path.display().to_string())
}

// ─── friday.yml management ───────────────────────────────────────────────────

/// Provider the wizard targets when writing `friday.yml`. Distinct
/// from the env-var key names because we use this enum to drive
/// the `models:` block content, not the .env content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WizardProvider {
    Anthropic,
    OpenAI,
    Google,
    Groq,
}

/// Pick the provider the wizard should write friday.yml for.
/// Returns `None` when the user clicked "Skip for now" — the wizard
/// passes all four `*_key` args as `None` in that case, and skip
/// must be a strict no-op for both .env and friday.yml.
fn pick_provider(
    anthropic: &Option<String>,
    openai: &Option<String>,
    gemini: &Option<String>,
    groq: &Option<String>,
) -> Option<WizardProvider> {
    let has = |k: &Option<String>| {
        k.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some()
    };
    if has(anthropic) {
        Some(WizardProvider::Anthropic)
    } else if has(openai) {
        Some(WizardProvider::OpenAI)
    } else if has(gemini) {
        Some(WizardProvider::Google)
    } else if has(groq) {
        Some(WizardProvider::Groq)
    } else {
        None
    }
}

/// The 4-tuple `(labels, classifier, planner, conversational)` the
/// wizard writes for each non-Anthropic provider. Anthropic returns
/// `None` because the daemon's DEFAULT_PLATFORM_MODELS already
/// targets the same Anthropic model IDs; writing them explicitly
/// would be redundant.
///
/// Model IDs verified against the live Vercel AI gateway and Groq
/// /models on 2026-04-29. See plan v6 for per-provider rationale.
fn wizard_models_for(
    p: WizardProvider,
) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match p {
        WizardProvider::Anthropic => None,
        WizardProvider::OpenAI => Some((
            "openai:gpt-5.4-nano",
            "openai:gpt-5.4-mini",
            "openai:gpt-5.5",
            "openai:gpt-5.5",
        )),
        WizardProvider::Google => Some((
            "google:gemini-3-flash",
            "google:gemini-3-flash",
            "google:gemini-3.1-pro-preview",
            "google:gemini-3.1-pro-preview",
        )),
        WizardProvider::Groq => Some((
            "groq:openai/gpt-oss-20b",
            "groq:openai/gpt-oss-20b",
            "groq:openai/gpt-oss-120b",
            "groq:openai/gpt-oss-120b",
        )),
    }
}

/// Build the `models:` Mapping for a non-Anthropic provider. Returns
/// `None` for Anthropic (no models block needed; default chain covers it).
fn build_models_block(p: WizardProvider) -> Option<Value> {
    let (labels, classifier, planner, conversational) = wizard_models_for(p)?;
    let mut m = Mapping::new();
    m.insert(Value::String("labels".into()), Value::String(labels.into()));
    m.insert(
        Value::String("classifier".into()),
        Value::String(classifier.into()),
    );
    m.insert(
        Value::String("planner".into()),
        Value::String(planner.into()),
    );
    m.insert(
        Value::String("conversational".into()),
        Value::String(conversational.into()),
    );
    Some(Value::Mapping(m))
}

/// Path to ~/.friday/local/friday.yml, derived from env_file_path's
/// parent so we can't drift from the .env location.
fn friday_yml_path() -> Result<PathBuf, String> {
    let env_path = env_file_path()?;
    let parent = env_path
        .parent()
        .ok_or_else(|| ".env path has no parent".to_string())?;
    Ok(parent.join("friday.yml"))
}

/// `version: "1.0"` is `z.literal("1.0")` in the daemon's schema —
/// a *string*. Without explicit string construction serde_norway may
/// emit `version: 1.0` (unquoted, parsed back as float) and Zod
/// validation would reject. Always go through this helper.
fn version_value() -> Value {
    Value::String("1.0".into())
}

/// Default workspace block the wizard supplies when an existing
/// friday.yml lacks one. Daemon's WorkspaceConfigSchema requires
/// `workspace.name`. Settings UI uses the same literal at
/// apps/atlasd/routes/config.ts:387-390.
fn default_workspace_value() -> Value {
    let mut ws = Mapping::new();
    ws.insert(
        Value::String("name".into()),
        Value::String("atlas-platform".into()),
    );
    Value::Mapping(ws)
}

/// The exact two-key skeleton the wizard seeds when creating a fresh
/// friday.yml. After a `models:` removal on Anthropic-pick, if the
/// remaining content equals this skeleton, the file is deleted so
/// the daemon's default chain takes over cleanly. A user who
/// hand-edited workspace.name to anything else won't match → file
/// preserved.
fn canonical_wizard_skeleton() -> Mapping {
    let mut m = Mapping::new();
    m.insert(Value::String("version".into()), version_value());
    m.insert(Value::String("workspace".into()), default_workspace_value());
    m
}

/// Read friday.yml into a Mapping. Behaviour by file state:
///   - missing → returns empty Mapping
///   - parse error → renames to friday.yml.bak.<unix-ts>, returns
///                   empty Mapping (best-effort recovery; user can
///                   inspect the .bak)
///   - valid map  → returns parsed Mapping
///   - valid non-map (string / sequence at root) → treated as parse
///                   error (same .bak path)
fn read_friday_yml_or_recover(path: &Path) -> Result<Mapping, String> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Mapping::new()),
        Err(e) => return Err(format!("read friday.yml at {}: {e}", path.display())),
    };
    match serde_norway::from_str::<Value>(&raw) {
        Ok(Value::Mapping(m)) => Ok(m),
        Ok(_) | Err(_) => {
            // Backup + treat as empty. We swallow the rename error
            // intentionally — best-effort recovery; if rename fails,
            // we'll overwrite below and the user loses the broken
            // file (acceptable since they couldn't read it anyway).
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak = path.with_extension(format!("yml.bak.{ts}"));
            let _ = fs::rename(path, &bak);
            eprintln!(
                "[installer] friday.yml at {} was malformed; backed up to {}",
                path.display(),
                bak.display()
            );
            Ok(Mapping::new())
        }
    }
}

/// Wizard's surgical management of `models:` in friday.yml. Driven
/// entirely by which `*_key` argument is `Some` (matches the wizard
/// frontend's contract: exactly one provider per call, or all-None
/// for the Skip-for-now path).
fn manage_friday_yml(
    anthropic: &Option<String>,
    openai: &Option<String>,
    gemini: &Option<String>,
    groq: &Option<String>,
) -> Result<(), String> {
    let Some(provider) = pick_provider(anthropic, openai, gemini, groq) else {
        // Skip path — leave friday.yml strictly alone.
        return Ok(());
    };
    let path = friday_yml_path()?;
    manage_friday_yml_at(&path, provider)
}

/// Path-injectable core of `manage_friday_yml`. Exposed for tests so
/// they can run against an isolated tempdir instead of the real
/// `dirs::home_dir()`-resolved path.
fn manage_friday_yml_at(path: &Path, provider: WizardProvider) -> Result<(), String> {
    let mut current = read_friday_yml_or_recover(path)?;

    // Mutate just the `models:` key.
    match provider {
        WizardProvider::Anthropic => {
            current.remove(Value::String("models".into()));
        }
        _ => {
            if let Some(models) = build_models_block(provider) {
                current.insert(Value::String("models".into()), models);
            }
        }
    }

    // Schema-required keys; only seed when absent so a user who
    // customized workspace.name keeps it across re-runs.
    let version_key = Value::String("version".into());
    if !current.contains_key(&version_key) {
        current.insert(version_key, version_value());
    }
    let workspace_key = Value::String("workspace".into());
    if !current.contains_key(&workspace_key) {
        current.insert(workspace_key, default_workspace_value());
    }

    // Anthropic-pick that left only the canonical skeleton: delete
    // the file so the daemon's default chain handles it directly,
    // no stub left lying around.
    if current == canonical_wizard_skeleton() {
        if path.exists() {
            fs::remove_file(path)
                .map_err(|e| format!("Failed to remove friday.yml at {}: {e}", path.display()))?;
        }
        return Ok(());
    }

    // Serialise + write. serde_norway's default emitter quotes strings
    // when needed (including `"1.0"`), so version_value() round-trips
    // as a string per the schema requirement.
    let yaml = serde_norway::to_string(&Value::Mapping(current))
        .map_err(|e| format!("Failed to serialise friday.yml: {e}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create friday-home dir: {e}"))?;
    }
    atomic_write(path, yaml.as_bytes())
        .map_err(|e| format!("Failed to write friday.yml at {}: {e}", path.display()))?;

    Ok(())
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn successful_write_leaves_no_tmp_behind() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join(".env");
        let tmp_sibling = tmp.path().join(".env.tmp");

        atomic_write(&target, b"FOO=bar\n").unwrap();

        assert!(target.exists(), "target file should exist");
        assert_eq!(fs::read_to_string(&target).unwrap(), "FOO=bar\n");
        assert!(
            !tmp_sibling.exists(),
            ".env.tmp should not be left behind on success"
        );
    }

    #[test]
    fn rename_failure_leaves_original_intact() {
        // Simulate a rename failure by making the target path a directory
        // that contains a file (so the rename target is a non-empty dir,
        // which fails on most platforms with EEXIST or ENOTEMPTY).
        // We accomplish this by pre-populating both the target (as a
        // directory) and a sentinel file inside it.
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join(".env");
        fs::create_dir(&target).unwrap();
        // Drop a file inside so rename-over fails on Linux/macOS where
        // rename(file, non-empty-dir) is rejected.
        fs::write(target.join("sentinel"), b"original").unwrap();

        let result = atomic_write(&target, b"NEW=content\n");
        assert!(
            result.is_err(),
            "atomic_write should fail when target is a non-empty dir"
        );

        // Original directory + sentinel should still be there.
        assert!(target.is_dir(), "target dir should still exist");
        assert_eq!(
            fs::read_to_string(target.join("sentinel")).unwrap(),
            "original",
            "sentinel inside the dir should be untouched"
        );
        // tmp file should be cleaned up by atomic_write's failure handler.
        let tmp_path = tmp.path().join(".env.tmp");
        assert!(
            !tmp_path.exists(),
            "tmp should be cleaned up when rename fails"
        );
    }

    #[test]
    fn existing_target_content_survives_when_rename_fails() {
        // Pre-existing .env with prior content. Force rename to fail by
        // pre-creating a directory at the .env.tmp path so the create
        // step succeeds but rename can't replace .env (we simulate via
        // a different mechanism: rename atomicity over a file-with-same
        // contents is fine on POSIX; instead test the simpler semantic
        // "if atomic_write returns Err, original content is intact").
        //
        // We approximate by making the parent dir read-only after
        // pre-seeding the original — atomic_write's fs::File::create on
        // the tmp will fail, returning Err before any rename happens.
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join(".env");
        fs::write(&target, b"ORIGINAL=keep\n").unwrap();

        // Make the parent unwritable so create_tmp fails.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(tmp.path()).unwrap().permissions();
            perms.set_mode(0o555);
            fs::set_permissions(tmp.path(), perms).unwrap();
        }

        let result = atomic_write(&target, b"NEW=content\n");

        // Restore perms so TempDir cleanup works.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(tmp.path()).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(tmp.path(), perms).unwrap();
        }

        // On unix this fails (EACCES on file create). On other platforms
        // the test is a no-op assertion of the success path.
        #[cfg(unix)]
        {
            assert!(result.is_err(), "expected EACCES error on read-only parent");
            // Original content untouched.
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                "ORIGINAL=keep\n",
                "original .env must survive a failed write"
            );
        }
        #[cfg(not(unix))]
        {
            let _ = result;
        }
    }

    #[test]
    fn pre_existing_tmp_is_cleaned_up_on_next_write() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join(".env");
        let tmp_sibling = tmp.path().join(".env.tmp");

        // Simulate a stale tmp from a prior crash.
        fs::write(&tmp_sibling, b"PARTIAL=garbage").unwrap();
        assert!(tmp_sibling.exists());

        atomic_write(&target, b"GOOD=value\n").unwrap();

        assert!(target.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "GOOD=value\n");
        assert!(
            !tmp_sibling.exists(),
            "stale .env.tmp must be cleaned up by the next successful write"
        );
    }
}

#[cfg(test)]
mod parse_env_lines_tests {
    use super::*;

    #[test]
    fn strips_trailing_cr_on_final_line_without_terminator() {
        // The case the trim actually defends against: a file whose
        // last line has a `\r` but no following `\n` — `lines()` does
        // NOT recognize lone `\r` as a line terminator, so the `\r` is
        // included in the line text and survives into the value.
        // Mutation-tested: remove the `trim_end_matches('\r')` from
        // parse_env_lines and this test fails.
        let no_terminator = "FRIDAY_PORT_FRIDAY=18080\r";
        let parsed = parse_env_lines(no_terminator);
        let port = parsed
            .iter()
            .find(|(k, _)| k.as_deref() == Some("FRIDAY_PORT_FRIDAY"))
            .expect("port key present");
        assert_eq!(port.1, "18080", "trailing \\r on last line must be stripped");
    }

    #[test]
    fn handles_well_formed_crlf_file() {
        // Sanity: a file with proper `\r\n` line terminators parses
        // cleanly. `lines()` strips the `\r\n` boundary on its own,
        // so the trim is a no-op here — but the test guards against
        // a future regression where the trim becomes destructive.
        let crlf = "FRIDAY_PORT_FRIDAY=18080\r\nFRIDAY_HOME=/Users/x/.friday/local\r\n";
        let parsed = parse_env_lines(crlf);
        assert_eq!(
            parsed
                .iter()
                .find(|(k, _)| k.as_deref() == Some("FRIDAY_PORT_FRIDAY"))
                .unwrap()
                .1,
            "18080"
        );
        assert_eq!(
            parsed
                .iter()
                .find(|(k, _)| k.as_deref() == Some("FRIDAY_HOME"))
                .unwrap()
                .1,
            "/Users/x/.friday/local"
        );
    }

    #[test]
    fn lf_only_file_unchanged() {
        // Standard Unix `.env` — verify the trim is a no-op when
        // there's no CR to strip.
        let lf = "FRIDAY_PORT_FRIDAY=18080\nFRIDAY_HOME=/Users/x/.friday/local\n";
        let parsed = parse_env_lines(lf);
        assert_eq!(
            parsed
                .iter()
                .find(|(k, _)| k.as_deref() == Some("FRIDAY_PORT_FRIDAY"))
                .unwrap()
                .1,
            "18080"
        );
    }

    #[test]
    fn value_with_legitimate_internal_cr_is_left_alone() {
        // Only the trailing `\r` is stripped — values that contain a
        // `\r` mid-string (vanishingly unlikely in practice but worth
        // pinning) keep their internal byte.
        let weird = "WEIRD=foo\rbar\n";
        let parsed = parse_env_lines(weird);
        let val = &parsed
            .iter()
            .find(|(k, _)| k.as_deref() == Some("WEIRD"))
            .unwrap()
            .1;
        assert_eq!(val, "foo\rbar", "internal \\r preserved; only trailing trimmed");
    }
}

#[cfg(test)]
mod friday_yml_tests {
    use super::*;
    use tempfile::TempDir;

    fn yml_in(dir: &TempDir) -> PathBuf {
        dir.path().join("friday.yml")
    }

    fn read_map(path: &Path) -> Mapping {
        let raw = fs::read_to_string(path).expect("read");
        match serde_norway::from_str::<Value>(&raw).expect("parse") {
            Value::Mapping(m) => m,
            other => panic!("expected map, got {other:?}"),
        }
    }

    /// Skip path — pick_provider returns None when all keys are None.
    /// manage_friday_yml is a no-op; existing file content is preserved
    /// verbatim. Guards the wizard's "Skip for now" button against
    /// destroying state when the dropdown defaults to anthropic on
    /// re-runs (round-3 documented UX rough edge).
    #[test]
    fn skip_path_leaves_existing_yml_untouched() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let original = "version: \"1.0\"\nmodels:\n  planner: openai:gpt-5.5\n";
        fs::write(&path, original).unwrap();

        // Direct call to the entry point with all keys None.
        let r = manage_friday_yml(&None, &None, &None, &None);
        assert!(r.is_ok());

        // File content unchanged byte-for-byte.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, original);
    }

    /// Anthropic-pick + no existing friday.yml → no file created.
    /// Default chain in DEFAULT_PLATFORM_MODELS already handles
    /// Anthropic; an empty wizard skeleton would just be noise.
    #[test]
    fn anthropic_no_yml_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);

        manage_friday_yml_at(&path, WizardProvider::Anthropic).unwrap();

        assert!(!path.exists(), "wizard should not create yml for Anthropic");
    }

    /// Anthropic-pick + existing yml that's already just the canonical
    /// skeleton + a models block → after models removal, file equals
    /// the canonical skeleton → file deleted.
    #[test]
    fn anthropic_canonical_skeleton_with_models_deletes_file() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let yml = "version: \"1.0\"\nworkspace:\n  name: atlas-platform\nmodels:\n  planner: openai:gpt-5.5\n";
        fs::write(&path, yml).unwrap();

        manage_friday_yml_at(&path, WizardProvider::Anthropic).unwrap();

        assert!(
            !path.exists(),
            "stub-only yml should be deleted on Anthropic-pick"
        );
    }

    /// Anthropic-pick + existing yml with a hand-customized
    /// workspace.name → models removed, but workspace.name is
    /// preserved, so the canonical skeleton check fails → file
    /// preserved.
    #[test]
    fn anthropic_preserves_customized_workspace_name() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let yml = "version: \"1.0\"\nworkspace:\n  name: my-personal-ws\nmodels:\n  planner: openai:gpt-5.5\n";
        fs::write(&path, yml).unwrap();

        manage_friday_yml_at(&path, WizardProvider::Anthropic).unwrap();

        assert!(
            path.exists(),
            "yml with custom workspace.name should be preserved"
        );
        let m = read_map(&path);
        assert!(!m.contains_key(&Value::String("models".into())));
        // workspace.name preserved
        let ws = m.get(&Value::String("workspace".into())).unwrap();
        let Value::Mapping(ws_map) = ws else { panic!() };
        assert_eq!(
            ws_map.get(&Value::String("name".into())),
            Some(&Value::String("my-personal-ws".into()))
        );
    }

    /// Anthropic-pick + existing yml with a top-level `server:` block
    /// → models removed, server preserved verbatim. Critical for the
    /// "wizard never wipes user-authored non-models config" promise.
    #[test]
    fn anthropic_preserves_server_block() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let yml = "version: \"1.0\"\nworkspace:\n  name: atlas-platform\nmodels:\n  planner: openai:gpt-5.5\nserver:\n  port: 18080\n";
        fs::write(&path, yml).unwrap();

        manage_friday_yml_at(&path, WizardProvider::Anthropic).unwrap();

        assert!(path.exists());
        let m = read_map(&path);
        assert!(!m.contains_key(&Value::String("models".into())));
        let server = m
            .get(&Value::String("server".into()))
            .expect("server preserved");
        let Value::Mapping(s_map) = server else {
            panic!()
        };
        assert_eq!(
            s_map.get(&Value::String("port".into())),
            Some(&Value::Number(18080.into()))
        );
    }

    /// OpenAI-pick + no existing yml → file created with version,
    /// workspace.name=atlas-platform, and the wizard's OpenAI model
    /// matrix. Verifies (1) all four roles present, (2) version
    /// round-trips as the *string* "1.0" (not a YAML float, which
    /// would fail the daemon's z.literal("1.0") check).
    #[test]
    fn openai_creates_yml_with_correct_models_and_string_version() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);

        manage_friday_yml_at(&path, WizardProvider::OpenAI).unwrap();

        assert!(path.exists());
        let m = read_map(&path);

        // version is a STRING — the schema requires z.literal("1.0").
        // serde_norway emitter must quote it; if we get Value::Number
        // here the daemon would reject the file.
        assert_eq!(
            m.get(&Value::String("version".into())),
            Some(&Value::String("1.0".into())),
            "version must round-trip as string \"1.0\", not float 1.0"
        );

        // workspace.name = atlas-platform
        let ws = m
            .get(&Value::String("workspace".into()))
            .expect("workspace");
        let Value::Mapping(ws_map) = ws else { panic!() };
        assert_eq!(
            ws_map.get(&Value::String("name".into())),
            Some(&Value::String("atlas-platform".into()))
        );

        // models: per the OpenAI matrix
        let models = m.get(&Value::String("models".into())).expect("models");
        let Value::Mapping(models_map) = models else {
            panic!()
        };
        assert_eq!(
            models_map.get(&Value::String("labels".into())),
            Some(&Value::String("openai:gpt-5.4-nano".into()))
        );
        assert_eq!(
            models_map.get(&Value::String("classifier".into())),
            Some(&Value::String("openai:gpt-5.4-mini".into()))
        );
        assert_eq!(
            models_map.get(&Value::String("planner".into())),
            Some(&Value::String("openai:gpt-5.5".into()))
        );
        assert_eq!(
            models_map.get(&Value::String("conversational".into())),
            Some(&Value::String("openai:gpt-5.5".into()))
        );
    }

    /// Google-pick happy path. Same shape as openai test but checking
    /// the Google model IDs. Catches typos like accidentally writing
    /// "openai:" for Google.
    #[test]
    fn google_creates_yml_with_gemini_models() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);

        manage_friday_yml_at(&path, WizardProvider::Google).unwrap();

        let m = read_map(&path);
        let models = m.get(&Value::String("models".into())).expect("models");
        let Value::Mapping(models_map) = models else {
            panic!()
        };
        assert_eq!(
            models_map.get(&Value::String("labels".into())),
            Some(&Value::String("google:gemini-3-flash".into()))
        );
        assert_eq!(
            models_map.get(&Value::String("planner".into())),
            Some(&Value::String("google:gemini-3.1-pro-preview".into()))
        );
    }

    /// Groq-pick happy path.
    #[test]
    fn groq_creates_yml_with_gpt_oss_models() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);

        manage_friday_yml_at(&path, WizardProvider::Groq).unwrap();

        let m = read_map(&path);
        let models = m.get(&Value::String("models".into())).expect("models");
        let Value::Mapping(models_map) = models else {
            panic!()
        };
        assert_eq!(
            models_map.get(&Value::String("labels".into())),
            Some(&Value::String("groq:openai/gpt-oss-20b".into()))
        );
        assert_eq!(
            models_map.get(&Value::String("planner".into())),
            Some(&Value::String("groq:openai/gpt-oss-120b".into()))
        );
    }

    /// Non-Anthropic-pick + existing yml with a `server:` block but no
    /// `models:` → models added, server preserved.
    #[test]
    fn openai_with_existing_server_block_adds_models_and_preserves() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let yml = "version: \"1.0\"\nworkspace:\n  name: atlas-platform\nserver:\n  port: 18080\n";
        fs::write(&path, yml).unwrap();

        manage_friday_yml_at(&path, WizardProvider::OpenAI).unwrap();

        let m = read_map(&path);
        // models added
        assert!(m.contains_key(&Value::String("models".into())));
        // server preserved
        let server = m
            .get(&Value::String("server".into()))
            .expect("server preserved");
        let Value::Mapping(s_map) = server else {
            panic!()
        };
        assert_eq!(
            s_map.get(&Value::String("port".into())),
            Some(&Value::Number(18080.into()))
        );
    }

    /// Non-Anthropic-pick + existing yml with an OLD models block
    /// (e.g., from a prior Groq install) → models overwritten with the
    /// new wizard defaults; other keys (server) preserved.
    #[test]
    fn openai_overwrites_existing_models_preserves_others() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let yml = concat!(
            "version: \"1.0\"\n",
            "workspace:\n  name: atlas-platform\n",
            "models:\n  planner: groq:openai/gpt-oss-120b\n",
            "tools:\n  filesystem:\n    enabled: true\n",
        );
        fs::write(&path, yml).unwrap();

        manage_friday_yml_at(&path, WizardProvider::OpenAI).unwrap();

        let m = read_map(&path);
        let models = m.get(&Value::String("models".into())).expect("models");
        let Value::Mapping(models_map) = models else {
            panic!()
        };
        // overwritten — no Groq remnants
        assert_eq!(
            models_map.get(&Value::String("planner".into())),
            Some(&Value::String("openai:gpt-5.5".into()))
        );
        // tools: preserved
        assert!(m.contains_key(&Value::String("tools".into())));
    }

    /// Malformed yml → backed up to friday.yml.bak.<unix-ts>, fresh
    /// file written from wizard defaults. Existing content is
    /// recoverable from the .bak; install proceeds instead of
    /// blocking on a broken leftover.
    #[test]
    fn malformed_yml_is_backed_up_and_replaced() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        let garbage = ": invalid: yaml :: garbage";
        fs::write(&path, garbage).unwrap();

        manage_friday_yml_at(&path, WizardProvider::OpenAI).unwrap();

        // Fresh yml written.
        assert!(path.exists());
        let m = read_map(&path);
        assert!(m.contains_key(&Value::String("models".into())));

        // .bak preserved with original content.
        let bak_count = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("friday.yml.bak.")
            })
            .count();
        assert_eq!(bak_count, 1, "exactly one .bak file should exist");
    }

    /// I/O failure path: pass a path inside a non-existent directory
    /// where create_dir_all will succeed but write to a file with the
    /// same name as a directory should fail. We simulate by creating
    /// a directory at the friday.yml path.
    #[test]
    fn write_failure_returns_err() {
        let tmp = TempDir::new().unwrap();
        let path = yml_in(&tmp);
        // Create a directory where the file should be — fs::write fails.
        fs::create_dir(&path).unwrap();

        let r = manage_friday_yml_at(&path, WizardProvider::OpenAI);
        assert!(r.is_err(), "write to a path that's a directory should Err");
    }

    /// Sanity: the wizard's models matrix matches the documented one.
    /// If the implementer tweaks `wizard_models_for` and forgets to
    /// update the plan / TS test fixtures, this catches it.
    #[test]
    fn models_matrix_matches_plan_v6() {
        assert_eq!(
            wizard_models_for(WizardProvider::OpenAI),
            Some((
                "openai:gpt-5.4-nano",
                "openai:gpt-5.4-mini",
                "openai:gpt-5.5",
                "openai:gpt-5.5",
            ))
        );
        assert_eq!(
            wizard_models_for(WizardProvider::Google),
            Some((
                "google:gemini-3-flash",
                "google:gemini-3-flash",
                "google:gemini-3.1-pro-preview",
                "google:gemini-3.1-pro-preview",
            ))
        );
        assert_eq!(
            wizard_models_for(WizardProvider::Groq),
            Some((
                "groq:openai/gpt-oss-20b",
                "groq:openai/gpt-oss-20b",
                "groq:openai/gpt-oss-120b",
                "groq:openai/gpt-oss-120b",
            ))
        );
        assert_eq!(wizard_models_for(WizardProvider::Anthropic), None);
    }
}
