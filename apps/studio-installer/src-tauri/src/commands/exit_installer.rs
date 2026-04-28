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
// Note: we exit the INSTALLER, not the launcher. The launcher was
// spawned detached (setsid) at launch_studio time and keeps running
// independently — closing the wizard does not affect it.

use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn exit_installer<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
