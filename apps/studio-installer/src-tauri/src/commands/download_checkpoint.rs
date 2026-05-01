use std::env;

fn complete_path(platform: &str) -> std::path::PathBuf {
    env::temp_dir().join(format!("friday-studio-{platform}.complete"))
}

#[tauri::command]
pub fn mark_download_complete(platform: String) -> Result<(), String> {
    let path = complete_path(&platform);
    std::fs::write(&path, b"")
        .map_err(|e| format!("Failed to write checkpoint file: {e}"))
}

#[tauri::command]
pub fn check_download_complete(platform: String) -> Result<bool, String> {
    Ok(complete_path(&platform).exists())
}
