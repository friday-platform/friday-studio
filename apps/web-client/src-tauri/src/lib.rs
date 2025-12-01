use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{Menu, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
use objc2_app_kit::NSOpenPanel;
#[cfg(target_os = "macos")]
use objc2_foundation::MainThreadMarker;

#[cfg(target_os = "windows")]
use windows::{
    Win32::Foundation::HWND,
    Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    },
    Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_ALLOWMULTISELECT, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    },
};

#[cfg(target_os = "linux")]
use gtk::prelude::*;
#[cfg(target_os = "linux")]
use gtk::{FileChooserAction, FileChooserNative, ResponseType};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn show_about_dialog(app: AppHandle) {
    app.emit("show-about-dialog", ()).unwrap();
}

#[tauri::command]
async fn run_diagnostics(app: AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    // Try to find atlas binary in multiple locations
    let atlas_path = if cfg!(target_os = "windows") {
        let home = std::env::var("USERPROFILE")
            .map_err(|_| "Could not determine home directory".to_string())?;
        format!("{}\\.atlas\\bin\\atlas.exe", home)
    } else {
        // Try system path first (for package installations)
        let system_path = "/usr/bin/atlas";
        if std::path::Path::new(system_path).exists() {
            system_path.to_string()
        } else {
            // Fall back to user installation
            let home = std::env::var("HOME")
                .map_err(|_| "Could not determine home directory".to_string())?;
            format!("{}/.atlas/bin/atlas", home)
        }
    };

    // Emit initial progress update
    app.emit("diagnostics-progress", "Starting diagnostics collection...")
        .unwrap();

    // Run atlas diagnostics send and capture stdout in real-time
    #[cfg(target_os = "windows")]
    let mut child = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new(&atlas_path)
            .args(["diagnostics", "send"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to run atlas diagnostics send at {}: {}",
                    atlas_path, e
                )
            })?
    };

    #[cfg(not(target_os = "windows"))]
    let mut child = Command::new(&atlas_path)
        .args(["diagnostics", "send"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to run atlas diagnostics send at {}: {}",
                atlas_path, e
            )
        })?;

    // Read stdout line by line and emit progress updates
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            // Try to parse JSON log format and extract the message field
            if line.contains(r#""message":""#) {
                // Simple JSON message extraction
                let parts: Vec<&str> = line.split(r#""message":""#).collect();
                if parts.len() > 1 {
                    // Find the closing quote for the message value
                    if let Some(end_pos) = parts[1].find('"') {
                        let message = &parts[1][..end_pos];
                        app.emit("diagnostics-progress", message).unwrap();
                        continue;
                    }
                }
            }
            // Fallback to emitting the entire line if not JSON or parsing fails
            app.emit("diagnostics-progress", &line).unwrap();
        }
    }

    // Wait for the process to complete
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for diagnostics: {}", e))?;

    if output.status.success() {
        Ok("Diagnostics completed successfully".to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Diagnostics failed: {}", error))
    }
}

#[tauri::command]
fn read_env_file() -> Result<HashMap<String, String>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())?;

    let env_path = PathBuf::from(home).join(".atlas").join(".env");

    if !env_path.exists() {
        return Ok(HashMap::new());
    }

    let content =
        fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env file: {}", e))?;

    let mut env_vars = HashMap::new();

    for line in content.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Parse KEY=VALUE format
        if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim().to_string();
            let value = line[eq_pos + 1..].trim().to_string();

            // Remove quotes if present
            let value = if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value[1..value.len() - 1].to_string()
            } else {
                value
            };

            env_vars.insert(key, value);
        }
    }

    Ok(env_vars)
}

#[tauri::command]
fn write_env_file(env_vars: HashMap<String, String>) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())?;

    let atlas_dir = PathBuf::from(home).join(".atlas");
    let env_path = atlas_dir.join(".env");

    // Create .atlas directory if it doesn't exist
    if !atlas_dir.exists() {
        fs::create_dir_all(&atlas_dir)
            .map_err(|e| format!("Failed to create .atlas directory: {}", e))?;
    }

    // Sort keys alphabetically
    let mut sorted_keys: Vec<String> = env_vars.keys().cloned().collect();
    sorted_keys.sort();

    // Build the content with sorted keys
    let mut content = String::new();
    for key in sorted_keys {
        let value = env_vars.get(&key).unwrap();

        // Add quotes if the value contains spaces or special characters
        let formatted_value = if value.contains(' ') || value.contains('\n') || value.contains('\t')
        {
            format!("\"{}\"", value)
        } else {
            value.clone()
        };

        content.push_str(&format!("{}={}\n", key, formatted_value));
    }

    // Write the file
    fs::write(&env_path, content).map_err(|e| format!("Failed to write .env file: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn open_file_or_folder_picker(
    app: AppHandle,
    multiple: bool,
    _folders_only: bool,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    let folders_only = _folders_only;
    #[cfg(target_os = "macos")]
    {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();

        // Run on main thread
        app.run_on_main_thread(move || {
            unsafe {
                let mtm = MainThreadMarker::new_unchecked();
                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseFiles(true);
                panel.setCanChooseDirectories(true);
                panel.setAllowsMultipleSelection(multiple);

                let response = panel.runModal();

                let result = if response == 1 {
                    // NSModalResponseOK = 1
                    let urls = panel.URLs();
                    let mut paths = Vec::new();

                    for i in 0..urls.count() {
                        let url = urls.objectAtIndex(i);
                        if let Some(path) = url.path() {
                            paths.push(path.to_string());
                        }
                    }
                    Ok(paths)
                } else {
                    Ok(Vec::new())
                };

                let _ = tx.send(result);
            }
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;

        rx.recv()
            .map_err(|e| format!("Failed to receive result: {}", e))?
    }

    #[cfg(target_os = "windows")]
    {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();

        // Run on main thread
        app.run_on_main_thread(move || {
            let result = unsafe {
                // Initialize COM
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

                let dialog_result =
                    (|| -> Result<Vec<String>, String> {
                        // Create FileOpenDialog
                        let dialog: IFileOpenDialog =
                            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                                .map_err(|e| format!("Failed to create dialog: {}", e))?;

                        // Set options for multiple selection and file/folder mode
                        let mut options = dialog
                            .GetOptions()
                            .map_err(|e| format!("Failed to get options: {}", e))?;

                        if multiple {
                            options |= FOS_ALLOWMULTISELECT;
                        }

                        if folders_only {
                            options |= FOS_PICKFOLDERS;
                        }

                        dialog
                            .SetOptions(options)
                            .map_err(|e| format!("Failed to set options: {}", e))?;

                        // Show the dialog
                        dialog
                            .Show(Some(HWND(std::ptr::null_mut())))
                            .map_err(|e| format!("Dialog cancelled or failed: {}", e))?;

                        // Get results
                        if multiple {
                            let results = dialog
                                .GetResults()
                                .map_err(|e| format!("Failed to get results: {}", e))?;

                            let count = results
                                .GetCount()
                                .map_err(|e| format!("Failed to get count: {}", e))?;

                            let mut paths = Vec::new();
                            for i in 0..count {
                                let item = results
                                    .GetItemAt(i)
                                    .map_err(|e| format!("Failed to get item {}: {}", i, e))?;

                                let path = item
                                    .GetDisplayName(SIGDN_FILESYSPATH)
                                    .map_err(|e| format!("Failed to get path: {}", e))?;

                                paths.push(path.to_string().map_err(|e| {
                                    format!("Failed to convert path to string: {}", e)
                                })?);
                            }

                            Ok(paths)
                        } else {
                            let item = dialog
                                .GetResult()
                                .map_err(|e| format!("Failed to get result: {}", e))?;

                            let path = item
                                .GetDisplayName(SIGDN_FILESYSPATH)
                                .map_err(|e| format!("Failed to get path: {}", e))?;

                            Ok(vec![path.to_string().map_err(|e| {
                                format!("Failed to convert path to string: {}", e)
                            })?])
                        }
                    })();

                // Uninitialize COM
                CoUninitialize();

                dialog_result
            };

            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;

        rx.recv()
            .map_err(|e| format!("Failed to receive result: {}", e))?
    }

    #[cfg(target_os = "linux")]
    {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();

        // Run on main thread
        app.run_on_main_thread(move || {
            let result = || -> Result<Vec<String>, String> {
                // Initialize GTK if not already initialized
                if !gtk::is_initialized() {
                    gtk::init().map_err(|_| "Failed to initialize GTK".to_string())?;
                }

                // Use FileChooserNative for native Linux file dialog
                let action = if _folders_only {
                    FileChooserAction::SelectFolder
                } else {
                    FileChooserAction::Open
                };

                let dialog = FileChooserNative::new(
                    Some("Select Files or Folders"),
                    None::<&gtk::Window>,
                    action,
                    Some("Open"),
                    Some("Cancel"),
                );

                dialog.set_select_multiple(multiple);

                let response = dialog.run();

                if response == ResponseType::Accept {
                    let paths: Vec<String> = dialog
                        .filenames()
                        .into_iter()
                        .filter_map(|path| path.to_str().map(|s| s.to_string()))
                        .collect();
                    Ok(paths)
                } else {
                    Ok(Vec::new())
                }
            };

            let _ = tx.send(result());
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;

        rx.recv()
            .map_err(|e| format!("Failed to receive result: {}", e))?
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Custom file picker only supported on macOS, Windows, and Linux.".to_string())
    }
}

#[tauri::command]
async fn restart_atlas_daemon() -> Result<String, String> {
    // Try to find atlas binary in multiple locations
    let atlas_bin = if cfg!(target_os = "windows") {
        let home = std::env::var("USERPROFILE")
            .map_err(|_| "Could not determine home directory".to_string())?;
        PathBuf::from(home)
            .join(".atlas")
            .join("bin")
            .join("atlas.exe")
    } else {
        // Try system path first (for package installations)
        let system_path = PathBuf::from("/usr/bin/atlas");
        if system_path.exists() {
            system_path
        } else {
            // Fall back to user installation
            let home = std::env::var("HOME")
                .map_err(|_| "Could not determine home directory".to_string())?;
            PathBuf::from(home).join(".atlas").join("bin").join("atlas")
        }
    };

    if !atlas_bin.exists() {
        return Err(format!("Atlas binary not found at: {:?}", atlas_bin));
    }

    // Run 'atlas service restart'
    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new(&atlas_bin)
            .args(["service", "restart"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to restart atlas service: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(&atlas_bin)
        .args(["service", "restart"])
        .output()
        .map_err(|e| format!("Failed to restart atlas service: {}", e))?;

    if output.status.success() {
        Ok("Atlas daemon restarted successfully".to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Failed to restart atlas service: {}", error))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            show_about_dialog,
            run_diagnostics,
            read_env_file,
            write_env_file,
            restart_atlas_daemon,
            open_file_or_folder_picker
        ])
        .setup(|app| {
            // Create Settings menu item with keyboard shortcut
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;

            // Note: Using system Services menu to get native double gear icon

            // Create the Discord help menu item
            let discord_help = MenuItem::with_id(
                app,
                "discord_help",
                "Get Help on Discord",
                true,
                None::<&str>,
            )?;

            // Create diagnostics menu item
            let diagnostics_item = MenuItem::with_id(
                app,
                "run_diagnostics",
                "Run Diagnostics",
                true,
                None::<&str>,
            )?;

            // Create atlas logs menu item
            let atlas_logs_item =
                MenuItem::with_id(app, "atlas_logs", "Atlas Logs", true, None::<&str>)?;

            // Create custom About menu item with specific ID and icon
            let about_item =
                MenuItem::with_id(app, "about-custom", "About Atlas", true, None::<&str>)?;

            // Create app menu (macOS only)
            #[cfg(target_os = "macos")]
            let app_menu = {
                let menu = Submenu::new(app, "Atlas Web Client", true)?;
                menu.append(&about_item)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&settings_item)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&PredefinedMenuItem::services(app, None)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&PredefinedMenuItem::hide(app, None)?)?;
                menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
                menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&PredefinedMenuItem::quit(app, None)?)?;
                menu
            };

            // Create file menu
            let file_menu = Submenu::new(app, "File", true)?;
            #[cfg(target_os = "macos")]
            file_menu.append(&PredefinedMenuItem::close_window(app, None)?)?;
            #[cfg(not(target_os = "macos"))]
            {
                file_menu.append(&settings_item)?;
                file_menu.append(&PredefinedMenuItem::separator(app)?)?;
                file_menu.append(&PredefinedMenuItem::quit(app, None)?)?;
            }

            // Create edit menu
            let edit_menu = Submenu::new(app, "Edit", true)?;
            #[cfg(target_os = "macos")]
            {
                edit_menu.append(&PredefinedMenuItem::undo(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::redo(app, None)?)?;
                edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
            edit_menu.append(&PredefinedMenuItem::cut(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::copy(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::paste(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::select_all(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::separator(app)?)?;

            // Create Find menu item
            let find_item = MenuItem::with_id(app, "find", "Find...", true, Some("CmdOrCtrl+F"))?;
            edit_menu.append(&find_item)?;

            // Create view menu
            let view_menu = Submenu::new(app, "View", true)?;
            #[cfg(target_os = "macos")]
            view_menu.append(&PredefinedMenuItem::fullscreen(app, None)?)?;

            // Create window menu
            let window_menu = Submenu::new(app, "Window", true)?;
            window_menu.append(&PredefinedMenuItem::minimize(app, None)?)?;
            #[cfg(target_os = "macos")]
            window_menu.append(&PredefinedMenuItem::maximize(app, None)?)?;

            // Create help menu with Discord link and diagnostics
            let help_menu = Submenu::new(app, "Help", true)?;
            #[cfg(not(target_os = "macos"))]
            help_menu.append(&about_item)?;
            #[cfg(not(target_os = "macos"))]
            help_menu.append(&PredefinedMenuItem::separator(app)?)?;
            help_menu.append(&diagnostics_item)?;
            help_menu.append(&atlas_logs_item)?;
            help_menu.append(&PredefinedMenuItem::separator(app)?)?;
            help_menu.append(&discord_help)?;

            // Build the menu (platform-specific)
            #[cfg(target_os = "macos")]
            let menu = Menu::with_items(
                app,
                &[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &window_menu,
                    &help_menu,
                ],
            )?;

            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(
                app,
                &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
            )?;

            // Set the menu for the app
            app.set_menu(menu)?;

            // Handle menu item clicks
            app.on_menu_event(move |app, event| {
                if event.id() == &MenuId("discord_help".to_string()) {
                    // Use invite link - redirects members to channel, shows invite for non-members
                    let _ = app
                        .opener()
                        .open_url("https://discord.gg/Mx5YFWmDuJ", None::<String>);
                } else if event.id() == &MenuId("settings".to_string()) {
                    // Emit event to show settings dialog
                    let _ = app.emit("show-settings-dialog", ());
                } else if event.id() == &MenuId("about-custom".to_string()) {
                    // Emit event to show about dialog
                    let _ = app.emit("show-about-dialog", ());
                } else if event.id() == &MenuId("run_diagnostics".to_string()) {
                    // Emit event to show diagnostics dialog
                    let _ = app.emit("show-diagnostics-dialog", ());
                } else if event.id() == &MenuId("find".to_string()) {
                    // Trigger native macOS find panel via JavaScript
                    #[cfg(target_os = "macos")]
                    {
                        // The native find panel in WKWebView requires special handling.
                        // For now, emit an event and handle it in the frontend.
                        let _ = app.emit("show-find", ());
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = app.emit("show-find", ());
                    }
                } else if event.id() == &MenuId("atlas_logs".to_string()) {
                    // Open Atlas logs file with default system editor
                    if let Ok(home) =
                        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
                    {
                        let log_path = PathBuf::from(home)
                            .join(".atlas")
                            .join("logs")
                            .join("global.log");
                        if log_path.exists() {
                            let _ = app
                                .opener()
                                .open_path(log_path.to_string_lossy().to_string(), None::<String>);
                        } else {
                            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                            let _ = app
                                .dialog()
                                .message("Log file does not exist")
                                .kind(MessageDialogKind::Info)
                                .title("Atlas Logs")
                                .blocking_show();
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
