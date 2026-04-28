// Public so integration tests under tests/ can call commands directly
// (specifically launch_studio in tests/launcher_handoff.rs).
pub mod commands;

use commands::{
    check_running::check_running_processes,
    create_app_bundle::create_app_bundle,
    delete_partial::delete_partial,
    download::download_file,
    download_checkpoint::{check_download_complete, mark_download_complete},
    env_file::write_env_file,
    exit_installer::exit_installer,
    extract::extract_archive,
    fetch_manifest::fetch_manifest,
    installed_marker::{read_installed, write_installed},
    launch::launch_studio,
    platform::{current_platform, install_dir},
    startup::create_startup_script,
    verify::verify_sha256,
    wait_health::{extend_wait_deadline, wait_for_services, WaitDeadlineState},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        // WaitDeadlineState carries the active wait-healthy
        // deadline so extend_wait_deadline can push it out without
        // re-spawning the whole stream. State is per-app-instance.
        .manage(WaitDeadlineState::default())
        .invoke_handler(tauri::generate_handler![
            download_file,
            delete_partial,
            mark_download_complete,
            check_download_complete,
            verify_sha256,
            extract_archive,
            check_running_processes,
            create_app_bundle,
            fetch_manifest,
            write_installed,
            read_installed,
            write_env_file,
            exit_installer,
            create_startup_script,
            launch_studio,
            current_platform,
            install_dir,
            wait_for_services,
            extend_wait_deadline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
