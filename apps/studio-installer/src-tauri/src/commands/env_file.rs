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

#[tauri::command]
pub fn write_env_file(
    anthropic_key: Option<String>,
    openai_key: Option<String>,
) -> Result<(), String> {
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

    // User-provided API keys (only if not already present)
    if let Some(ref key) = anthropic_key {
        if !existing_keys.contains_key("ANTHROPIC_API_KEY") {
            lines.push((Some("ANTHROPIC_API_KEY".to_string()), key.clone()));
        }
    }
    if let Some(ref key) = openai_key {
        if !existing_keys.contains_key("OPENAI_API_KEY") {
            lines.push((Some("OPENAI_API_KEY".to_string()), key.clone()));
        }
    }

    // Platform-internal vars — inline to avoid borrow-checker issues with closure
    let platform_vars = [
        ("ATLAS_LOCAL_ONLY", "true"),
        ("LINK_DEV_MODE", "true"),
        (
            "ATLAS_KEY",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsb2NhbC11c2VyIn0.local",
        ),
        ("ATLASD_URL", "http://localhost:8080"),
        ("VITE_EXTERNAL_DAEMON_URL", "http://localhost:8080"),
        ("VITE_EXTERNAL_TUNNEL_URL", "http://localhost:9090"),
    ];
    for (k, v) in platform_vars {
        if !existing_keys.contains_key(k) {
            lines.push((Some(k.to_string()), v.to_string()));
        }
    }

    let output = render_env_lines(&lines);
    fs::write(&path, output.as_bytes()).map_err(|e| format!("Failed to write .env file: {e}"))
}
