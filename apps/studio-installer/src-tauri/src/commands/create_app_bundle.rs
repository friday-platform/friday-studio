// create_app_bundle — produce /Applications/Friday Studio.app at the
// end of install so Spotlight can index the launcher and the user can
// re-launch it after Quit.
//
// Why we need this:
//   The platform tarball ships supervised binaries (launcher + 6
//   processes) flat under ~/.friday/local/. None of those is a macOS
//   .app bundle, so LaunchServices doesn't index any of them, and
//   Spotlight returns nothing for "Friday Studio". After the user
//   clicks Quit in the tray they have no way to start the launcher
//   again short of finding the binary in ~/.friday/local — a path
//   no end user should need to know about.
//
// What this produces:
//   /Applications/Friday Studio.app/
//   ├── Contents/
//   │   ├── Info.plist          — bundle metadata (name, version, id)
//   │   ├── MacOS/
//   │   │   └── Friday Studio   — copy of ~/.friday/local/friday-launcher
//   │   └── Resources/
//   │       └── AppIcon.icns    — embedded via include_bytes! at build time
//
// Why a copy and not a symlink:
//   LaunchServices is finicky about symlinks pointing outside the
//   bundle — first launch sometimes silently fails to register the
//   app. Copying the binary is ~10 MB on disk; trivial price for a
//   reliable install.
//
// Why no codesigning here:
//   Files created on the user's machine don't have the
//   com.apple.quarantine xattr, so Gatekeeper doesn't gate them on
//   first launch. The signed/notarized installer brought the launcher
//   to ~/.friday/local; the .app we create here is a thin wrapper
//   over an already-trusted binary on the user's own filesystem.
//
// Idempotent: if the .app already exists, replace its launcher binary
// in-place. That handles re-install / upgrade cleanly.

use std::fs;
use std::path::{Path, PathBuf};

const APP_BUNDLE_PATH: &str = "/Applications/Friday Studio.app";
const APP_EXECUTABLE_NAME: &str = "Friday Studio";
const APP_BUNDLE_IDENTIFIER: &str = "ai.hellofriday.studio";
const APP_ICON_NAME: &str = "AppIcon.icns";

// Embedded at compile time so the installer doesn't need to ship the
// raw .icns file separately. Same icon as the installer's own bundle
// (apps/studio-installer/src-tauri/icons/icon.icns) — Friday brand
// glyph, full-color for dock/Spotlight rendering. Without this the
// .app shows up with the macOS generic-document placeholder, which
// looks broken in Spotlight results.
const APP_ICON_DATA: &[u8] = include_bytes!("../../icons/icon.icns");

#[tauri::command]
pub fn create_app_bundle(launcher_path: String, version: String) -> Result<String, String> {
    let launcher = PathBuf::from(&launcher_path);
    if !launcher.is_file() {
        return Err(format!("launcher binary not found at {launcher_path}"));
    }

    let bundle = PathBuf::from(APP_BUNDLE_PATH);
    let contents = bundle.join("Contents");
    let macos_dir = contents.join("MacOS");
    let resources_dir = contents.join("Resources");
    let info_plist_path = contents.join("Info.plist");
    let exec_path = macos_dir.join(APP_EXECUTABLE_NAME);
    let icon_path = resources_dir.join(APP_ICON_NAME);

    fs::create_dir_all(&macos_dir)
        .map_err(|e| format!("create {}: {e}", macos_dir.display()))?;
    fs::create_dir_all(&resources_dir)
        .map_err(|e| format!("create {}: {e}", resources_dir.display()))?;

    // Replace the launcher binary atomically to avoid leaving a
    // half-written file if the user kicks off another install while
    // one is in flight: copy to a temp neighbour, then rename over.
    let tmp_exec = macos_dir.join(format!(".{APP_EXECUTABLE_NAME}.tmp"));
    fs::copy(&launcher, &tmp_exec)
        .map_err(|e| format!("copy launcher → {}: {e}", tmp_exec.display()))?;
    set_executable(&tmp_exec)?;
    fs::rename(&tmp_exec, &exec_path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp_exec.display(), exec_path.display()))?;

    fs::write(&icon_path, APP_ICON_DATA)
        .map_err(|e| format!("write {}: {e}", icon_path.display()))?;

    fs::write(&info_plist_path, info_plist(&version))
        .map_err(|e| format!("write {}: {e}", info_plist_path.display()))?;

    // Touch the bundle so Spotlight notices it on the next mds scan.
    // mdimport runs in the background regardless, but a touch on the
    // Contents dir makes the new .app appear in search faster.
    let _ = touch(&bundle);

    Ok(bundle.display().to_string())
}

fn info_plist(version: &str) -> String {
    // Minimal Info.plist that LaunchServices accepts. CFBundleExecutable
    // must match the filename inside Contents/MacOS/. The version
    // string is split into Short (user-facing) and Version (build);
    // we use the same value for both since we only have one.
    let escaped_version = xml_escape(version);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>{APP_EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>{APP_BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Friday Studio</string>
  <key>CFBundleDisplayName</key><string>Friday Studio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{escaped_version}</string>
  <key>CFBundleVersion</key><string>{escaped_version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!--
    LSUIElement=true makes Friday Studio a menu-bar-only "agent"
    app: no Dock icon, no Cmd+Tab entry, no application menu. The
    tray icon is the only surface. Without this the .app shows up
    in the Dock with a generic icon while the launcher (which runs
    headless apart from its NSStatusItem tray) provides no Dock
    interactions — clicking it does nothing useful.
    Quit still works via the tray menu, autostart still works, and
    Spotlight still finds the app for re-launch after Quit.
  -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"#
    )
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .permissions();
    perm.set_mode(0o755);
    fs::set_permissions(path, perm).map_err(|e| format!("chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn touch(path: &Path) -> std::io::Result<()> {
    let now = std::time::SystemTime::now();
    fs::File::open(path).and_then(|f| f.set_modified(now))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
