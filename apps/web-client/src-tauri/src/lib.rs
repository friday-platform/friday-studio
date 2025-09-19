use tauri::menu::{Menu, MenuItem, MenuId, PredefinedMenuItem, Submenu};
use tauri_plugin_opener::OpenerExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // Create the Discord help menu item
            let discord_help = MenuItem::with_id(app, "discord_help", "Get Help on Discord", true, None::<&str>)?;

            // Create app menu (macOS only)
            let app_menu = Submenu::new(app, "Atlas Web Client", true)?;
            app_menu.append(&PredefinedMenuItem::about(app, None, None)?)?;
            app_menu.append(&PredefinedMenuItem::separator(app)?)?;
            app_menu.append(&PredefinedMenuItem::services(app, None)?)?;
            app_menu.append(&PredefinedMenuItem::separator(app)?)?;
            app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
            app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
            app_menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
            app_menu.append(&PredefinedMenuItem::separator(app)?)?;
            app_menu.append(&PredefinedMenuItem::quit(app, None)?)?;

            // Create file menu
            let file_menu = Submenu::new(app, "File", true)?;
            file_menu.append(&PredefinedMenuItem::close_window(app, None)?)?;

            // Create edit menu
            let edit_menu = Submenu::new(app, "Edit", true)?;
            edit_menu.append(&PredefinedMenuItem::undo(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::redo(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
            edit_menu.append(&PredefinedMenuItem::cut(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::copy(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::paste(app, None)?)?;
            edit_menu.append(&PredefinedMenuItem::select_all(app, None)?)?;

            // Create view menu
            let view_menu = Submenu::new(app, "View", true)?;
            view_menu.append(&PredefinedMenuItem::fullscreen(app, None)?)?;

            // Create window menu
            let window_menu = Submenu::new(app, "Window", true)?;
            window_menu.append(&PredefinedMenuItem::minimize(app, None)?)?;
            window_menu.append(&PredefinedMenuItem::maximize(app, None)?)?;

            // Create help menu with Discord link
            let help_menu = Submenu::new(app, "Help", true)?;
            help_menu.append(&discord_help)?;

            // Build the menu
            let menu = Menu::with_items(
                app,
                &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
            )?;

            // Set the menu for the app
            app.set_menu(menu)?;

            // Handle the Discord help menu item click
            app.on_menu_event(move |app, event| {
                if event.id() == &MenuId("discord_help".to_string()) {
                    // Open Discord channel in browser using the opener plugin
                    let _ = app.opener().open_url("https://discord.com/channels/1400973996505436300/1404928095009509489", None::<String>);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
