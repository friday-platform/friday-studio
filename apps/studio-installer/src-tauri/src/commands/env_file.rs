use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn env_file_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".friday").join("local").join(".env"))
}

/// Parse a `.env`-format file into an ordered list of (key, value) pairs.
/// Lines that don't match `KEY=VALUE` are preserved as-is (comments, blanks).
fn parse_env_lines(content: &str) -> Vec<(Option<String>, String)> {
    content
        .lines()
        .map(|line| {
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim().to_string();
                if !key.is_empty() && !key.starts_with('#') {
                    return (Some(key), v.to_string());
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

    // Platform-internal vars — only added when missing so any user
    // overrides survive (someone editing .env to point FRIDAYD_URL
    // at a non-default daemon, etc.). The EXTERNAL_*_URL values are
    // read at runtime by the playground binary and injected into the
    // served HTML; the launcher passes the .env through to its
    // supervised processes so updating these is enough to retarget
    // browser-facing URLs without rebuilding.
    //
    // FRIDAY_KEY is intentionally NOT seeded here. The daemon's
    // ensureLocalFridayKey() (apps/atlas-cli/.../local-friday-key.ts)
    // generates a fresh ephemeral JWT in-process on every start when
    // the env var isn't set. Hardcoding a static JWT in the installer
    // would (1) ship a known token in clear in source and (2) skip the
    // daemon's richer payload (iss / email / user_metadata) for no
    // benefit — the signature isn't verified in local mode anyway.
    // Friday Studio reserves its own non-default port range so a user
    // running another local Friday instance, a stock atlasd from source,
    // or another tool on the conventional 5200/8080 ports doesn't clash
    // with the installed launcher. Coordinated set the wizard ALWAYS
    // writes on every install (overwrite semantics — see below):
    //
    //   FRIDAY_PORT_FRIDAY            18080  ← daemon (was 8080)
    //   FRIDAY_PORT_LINK              13100  ← link (was 3100)
    //   FRIDAY_PORT_WEBHOOK_TUNNEL    19090  ← tunnel (was 9090)
    //   FRIDAY_PORT_PLAYGROUND        15200  ← studio UI (was 5200)
    //
    // The launcher imports ~/.friday/local/.env into its own process env
    // (tools/friday-launcher/main.go's importDotEnvIntoProcessEnv), so
    // portOverride() picks up these values when supervisedProcesses()
    // builds each spec. The matching EXTERNAL_*_URL / FRIDAYD_URL values
    // below ensure the playground UI's window.__FRIDAY_CONFIG__ points
    // at the moved daemon + tunnel — auto-derive isn't possible because
    // the URLs may also include user-controlled hostnames or schemes
    // (reverse proxies, future cloud mode).
    //
    // OVERWRITE semantics: pre-Stack-3 builds wrote these values only
    // when the key was missing, so users would silently get whatever
    // was in .env from a previous version. That left installs running
    // on the legacy 8080/5200 ports even after a fresh install — the
    // exact bug the user hit. Always-overwrite means the installer is
    // the source of truth for port configuration; users who genuinely
    // want different ports can edit .env after install (the launcher
    // re-reads it on every restart).
    let platform_vars = [
        ("FRIDAY_LOCAL_ONLY", "true"),
        ("LINK_DEV_MODE", "true"),
        ("FRIDAY_PORT_FRIDAY", "18080"),
        ("FRIDAY_PORT_LINK", "13100"),
        ("FRIDAY_PORT_WEBHOOK_TUNNEL", "19090"),
        ("FRIDAY_PORT_PLAYGROUND", "15200"),
        ("FRIDAYD_URL", "http://localhost:18080"),
        ("EXTERNAL_DAEMON_URL", "http://localhost:18080"),
        ("EXTERNAL_TUNNEL_URL", "http://localhost:19090"),
    ];
    for (k, v) in platform_vars {
        match existing_keys.get(k) {
            Some(&i) => lines[i] = (Some(k.to_string()), v.to_string()),
            None => lines.push((Some(k.to_string()), v.to_string())),
        }
    }

    let output = render_env_lines(&lines);
    fs::write(&path, output.as_bytes()).map_err(|e| format!("Failed to write .env file: {e}"))?;

    // Read-back verification — catches the silent-fail case where
    // fs::write returned Ok but the file didn't actually land
    // (filesystem quirk, snapshotting, race with another writer).
    let written = fs::read_to_string(&path)
        .map_err(|e| format!("verify .env after write: {e}"))?;
    if !written.contains("FRIDAY_LOCAL_ONLY") {
        return Err(format!(
            ".env at {} did not contain expected platform vars after write",
            path.display()
        ));
    }
    Ok(path.display().to_string())
}
