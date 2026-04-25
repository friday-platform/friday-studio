/// Returns the manifest key matching the binary's compile-time target.
///
/// The studio-build pipeline emits one entry per key in `studio/manifest.json`
/// (`macos-arm`, `macos-intel`, `windows`); the installer must request the same
/// key on lookup or it will pull the wrong arch (e.g. arm64 binaries on Intel
/// → exec format error). Centralizing the cfg!() ladder here means renames
/// touch one file.
#[tauri::command]
pub fn current_platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "macos-intel"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        // Unsupported target — the wizard surfaces the resolveError.
        "unsupported"
    }
}

/// Returns the absolute path of the install root the installer should write to
/// and the launcher should spawn binaries from. Single source of truth so the
/// extract dest and launch dir don't drift.
#[tauri::command]
pub fn install_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let p = home.join(".friday").join("local");
    p.to_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| "Install path is not valid UTF-8".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_platform_is_one_of_the_known_keys() {
        let key = current_platform();
        assert!(matches!(key, "macos-arm" | "macos-intel" | "windows"));
    }
}
