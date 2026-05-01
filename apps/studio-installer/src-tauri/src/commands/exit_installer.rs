// exit_installer — invoked from the wizard's "Open in Browser"
// click handler after openUrl resolves, so the user gets one
// continuous gesture (click → browser opens → installer goes away).
//
// Why this isn't `getCurrentWindow().close()`:
//   - Tauri's JS `Window.close()` is permissioned and doesn't always
//     terminate the app process on macOS — closing the last window
//     can leave the app alive if Tauri's default close-requested
//     handler calls preventDefault for cleanup. Observed 2026-04-28:
//     "Open in Browser" opened the URL but the wizard window stayed
//     up.
//   - `app.exit(0)` from Rust bypasses every JS-level prevention path
//     and terminates the process directly.
//
// DMG-mounted-installer cleanup (darwin only):
//   When the installer is running from /Volumes/<name>/<App>.app — i.e.
//   the user double-clicked the .app inside a mounted .dmg without
//   copying it to /Applications first — we offer to eject the volume
//   and move the .dmg in their Downloads folder to the Trash. The
//   actual unmount happens AFTER our process exits, in a detached
//   shell job (you can't unmount a volume your own binary is reading
//   from), via `nohup sh -c 'sleep 2; hdiutil detach …; mv …'`.
//
// Note: we exit the INSTALLER, not the launcher. The launcher was
// spawned detached (setsid) at launch_studio time and keeps running
// independently — closing the wizard does not affect it.

use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn exit_installer<R: Runtime>(app: AppHandle<R>) {
    // Best-effort cleanup: if the user ran the installer directly
    // from a mounted DMG, offer to eject + trash. The cleanup
    // command is detached so it survives our exit; if anything
    // fails (volume already unmounted, .dmg already gone, etc.),
    // we ignore it — the user can always clean up manually.
    #[cfg(target_os = "macos")]
    {
        if let Some(volume) = current_dmg_volume() {
            if user_confirms_dmg_cleanup() {
                spawn_detached_cleanup(&volume);
            }
        }
    }
    app.exit(0);
}

/// Returns Some("/Volumes/<name>") when the running executable lives
/// on a DMG-mounted volume; None otherwise. Detected by walking
/// up from current_exe() until we find a path of the form
/// /Volumes/<single-segment>/...
#[cfg(target_os = "macos")]
fn current_dmg_volume() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut current = exe.as_path();
    while let Some(parent) = current.parent() {
        if parent == std::path::Path::new("/Volumes") {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
    None
}

/// Show an osascript yes/no prompt asking whether to eject the DMG
/// and trash the source .dmg file. Default button is "Move to Trash"
/// since cleanup is the more common intent — keeps the volume from
/// cluttering Finder + the .dmg from sitting in Downloads forever.
#[cfg(target_os = "macos")]
fn user_confirms_dmg_cleanup() -> bool {
    const BUTTON_KEEP: &str = "Keep";
    const BUTTON_TRASH: &str = "Move to Trash";
    // Reuses the same osascript helpers preflight uses (declared in
    // tools/friday-launcher in the launcher binary; we have our own
    // tiny version inline here since the installer doesn't share
    // that crate).
    let body = "Friday Studio is installed.\n\n\
        Eject the installer disk and move the .dmg to the Trash?";
    let script = format!(
        "display dialog {body} with title {title} \
         buttons {{{keep}, {trash}}} default button {trash} with icon note",
        body = applescript_string(body),
        title = applescript_string("Friday Studio Installer"),
        keep = applescript_string(BUTTON_KEEP),
        trash = applescript_string(BUTTON_TRASH),
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .ok();
    match out {
        Some(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains(BUTTON_TRASH)
        }
        None => false,
    }
}

/// Quote a string for AppleScript: wrap in double quotes, escape
/// embedded backslashes and quotes. AppleScript's `display dialog`
/// arguments must be valid expressions, so raw fmt %q won't do.
#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Spawn a detached shell job that waits for our process to exit,
/// then unmounts the DMG volume and moves the source .dmg to the
/// Trash. The `sleep 2` is the only reliable way to defer the
/// unmount past our exit — `hdiutil detach` of an in-use volume
/// fails with "Resource busy".
///
/// We use `mdfind` to locate the source .dmg by filename pattern.
/// The mounted volume's name is the user-visible label (e.g.
/// "Friday Studio Installer 0.1.28-aarch64-apple-darwin"); the .dmg
/// filename is `FridayStudioInstaller_<version>_<target>.dmg`. We
/// search for the broad pattern and trash the first match — works
/// for both arm64 and x86_64 builds, and skips harmlessly if the
/// .dmg has already been moved/deleted by the user.
///
/// Errors here are silent: the cleanup is best-effort. If `hdiutil
/// detach` fails the user sees a still-mounted volume; if `mdfind`
/// returns nothing the .dmg stays where it is. Either is recoverable
/// by the user with no special knowledge.
#[cfg(target_os = "macos")]
fn spawn_detached_cleanup(volume: &std::path::Path) {
    let volume_str = volume.display().to_string();
    let escaped_volume = shell_single_quote(&volume_str);
    // Volume name = last path component of /Volumes/<name>. Used to
    // tell Finder which window to close after the unmount.
    let volume_name = volume
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let escaped_volume_name_as = applescript_string(&volume_name);
    // Volume name is unused now that we don't tell Finder to close the
    // window — keep the binding declared above so a future fix that
    // restores the close step doesn't have to re-derive it.
    let _ = escaped_volume_name_as;
    let script = format!(
        r#"sleep 2
hdiutil detach {volume} -force >/dev/null 2>&1 || true
# Earlier revisions ran `osascript -e 'tell application "Finder" to
# close (every window whose name is …)'` here to clean up the Finder
# window that auto-opened when the DMG was first mounted. That
# triggers macOS's Automation TCC prompt ("osascript wants access to
# control Finder") on every install — every user gets the modal once
# per machine. Modern Finder closes the window on its own when the
# source volume goes away in most cases; in the rare miss, the user
# closes it with one click. Worth the tradeoff to avoid the prompt.
dmg=$(mdfind 'kMDItemFSName == "FridayStudioInstaller_*.dmg"' 2>/dev/null | head -1)
if [ -n "$dmg" ] && [ -e "$dmg" ]; then
  mv "$dmg" "$HOME/.Trash/" 2>/dev/null || true
fi"#,
        volume = escaped_volume,
    );
    // nohup + sh -c + & detaches the job from our process group, so
    // it survives our app.exit(0). stdin/stdout/stderr go to
    // /dev/null so the orphaned job doesn't hold a tty.
    let _ = Command::new("nohup")
        .arg("sh")
        .arg("-c")
        .arg(&script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Wrap a string in shell single quotes, escaping any embedded
/// single quotes via the standard `'\''` dance. Used so the volume
/// path can contain spaces (it always does — "Friday Studio
/// Installer …") without being split by the shell.
#[cfg(target_os = "macos")]
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}
