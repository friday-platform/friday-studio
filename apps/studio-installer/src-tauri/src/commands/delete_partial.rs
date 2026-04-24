use std::env;

#[tauri::command]
pub fn delete_partial(platform: String) -> Result<(), String> {
    let tmp = env::temp_dir();

    let candidates = [
        tmp.join(format!("friday-studio-{platform}.partial")),
        tmp.join(format!("friday-studio-{platform}.complete")),
        tmp.join(format!("friday-studio-{platform}.tar.gz")),
        tmp.join(format!("friday-studio-{platform}.zip")),
    ];

    for path in &candidates {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
        }
    }

    Ok(())
}
