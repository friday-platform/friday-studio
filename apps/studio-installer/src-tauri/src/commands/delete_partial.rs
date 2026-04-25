use std::env;
use std::fs;

/// Delete every partial archive in the temp dir for this platform key.
///
/// Both the legacy un-sha'd path (`friday-studio-<platform>.tar.gz`) and the
/// new sha-tagged paths (`friday-studio-<platform>-<sha12>.tar.gz`) need to
/// be cleaned up — Try Again should not leave any old version's bytes around
/// for a future Range-resume to splice into a different download.
#[tauri::command]
pub fn delete_partial(platform: String) -> Result<(), String> {
    let tmp = env::temp_dir();
    let prefix = format!("friday-studio-{platform}");

    let entries = match fs::read_dir(&tmp) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if !name_str.starts_with(&prefix) {
            continue;
        }
        // Only sweep our own archive shapes — never blanket-delete in /tmp.
        let lower = name_str.to_ascii_lowercase();
        let matches_ext = lower.ends_with(".tar.gz")
            || lower.ends_with(".zip")
            || lower.ends_with(".partial")
            || lower.ends_with(".complete");
        if !matches_ext {
            continue;
        }
        let path = entry.path();
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
    }

    Ok(())
}
