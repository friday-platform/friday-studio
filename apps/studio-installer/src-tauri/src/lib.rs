// Public so integration tests under tests/ can call commands directly
// (specifically launch_studio in tests/launcher_handoff.rs).
pub mod commands;

use commands::{
    check_running::check_running_processes,
    delete_partial::delete_partial,
    download::download_file,
    download_checkpoint::{check_download_complete, mark_download_complete},
    env_file::write_env_file,
    extract::extract_archive,
    fetch_manifest::fetch_manifest,
    installed_marker::{read_installed, write_installed},
    launch::launch_studio,
    platform::{current_platform, install_dir},
    startup::create_startup_script,
    verify::verify_sha256,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            download_file,
            delete_partial,
            mark_download_complete,
            check_download_complete,
            verify_sha256,
            extract_archive,
            check_running_processes,
            fetch_manifest,
            write_installed,
            read_installed,
            write_env_file,
            create_startup_script,
            launch_studio,
            current_platform,
            install_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
