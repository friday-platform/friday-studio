use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledMarker {
    pub version: String,
    pub installed_at: String,
}

fn marker_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".friday").join("local").join(".installed"))
}

fn marker_tmp_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home
        .join(".friday")
        .join("local")
        .join(".installed.tmp"))
}

fn now_rfc3339() -> String {
    // Use a simple ISO 8601 / RFC 3339 timestamp without pulling chrono.
    // std::time gives us SystemTime — format it manually.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Convert epoch seconds to Y-M-D H:M:S (UTC, simplified)
    let s = secs;
    let mins = s / 60;
    let sec = s % 60;
    let hours = mins / 60;
    let min = mins % 60;
    let days = hours / 24;
    let hour = hours % 24;

    // Days since epoch to calendar date (simplified Gregorian algorithm)
    let (year, month, day) = epoch_days_to_ymd(days);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn epoch_days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Simplified — good enough for marking timestamps
    let mut remaining = days;
    let mut year = 1970u64;

    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let month_days = if is_leap(year) {
        [31u64, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31u64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u64;
    for &md in &month_days {
        if remaining < md {
            break;
        }
        remaining -= md;
        month += 1;
    }

    (year, month, remaining + 1)
}

fn is_leap(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[tauri::command]
pub fn write_installed(version: String) -> Result<(), String> {
    let marker_path = marker_path()?;
    let tmp_path = marker_tmp_path()?;

    if let Some(parent) = marker_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .friday/local dir: {e}"))?;
    }

    let marker = InstalledMarker {
        version,
        installed_at: now_rfc3339(),
    };

    let json =
        serde_json::to_string(&marker).map_err(|e| format!("Serialization error: {e}"))?;

    fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| format!("Failed to write tmp marker: {e}"))?;

    fs::rename(&tmp_path, &marker_path)
        .map_err(|e| format!("Failed to rename marker file: {e}"))
}

#[tauri::command]
pub fn read_installed() -> Result<Option<InstalledMarker>, String> {
    let path = marker_path()?;

    if !path.exists() {
        return Ok(None);
    }

    let contents = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    match serde_json::from_str::<InstalledMarker>(&contents) {
        Ok(marker) => Ok(Some(marker)),
        Err(_) => {
            // Corrupted marker — delete and treat as not installed
            let _ = fs::remove_file(&path);
            Ok(None)
        }
    }
}
