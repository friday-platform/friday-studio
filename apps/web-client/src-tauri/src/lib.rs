use tauri::{menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder}};
use std::process::Command;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn send_diagnostics() -> String {
    "Diagnostics sent!".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let send_diagnostics_item = MenuItemBuilder::new("Send Diagnostics")
                .id("send_diagnostics")
                .build(app)?;
            
            let app_menu = SubmenuBuilder::new(app, "App")
                .items(&[&send_diagnostics_item])
                .build()?;
            
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu])
                .build()?;
            
            app.set_menu(menu)?;
            
            Ok(())
        })
        .on_menu_event(|_app, event| {
            match event.id().as_ref() {
                "send_diagnostics" => {
                    // TODO: call the diagnostics binary
                    match Command::new("sh")
                        .arg("-c")
                        .arg("echo 'Hello World!'")
                        .output() {
                        Ok(output) => {
                            let result = String::from_utf8_lossy(&output.stdout);
                            println!("RESULT 📯 {}", result);
                        }
                        Err(e) => {
                            eprintln!("Error executing command: {}", e);
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![greet, send_diagnostics])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
