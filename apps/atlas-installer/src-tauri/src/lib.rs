use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
#[cfg(not(target_os = "windows"))]
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Helper to create command without showing window on Windows
fn create_hidden_command(program: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct IPCResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl IPCResult {
    fn success(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: Some(message.into()),
            error: None,
        }
    }

    fn error(error: impl Into<String>) -> Self {
        Self {
            success: false,
            message: None,
            error: Some(error.into()),
        }
    }
}

// Platform detection
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

// Get home directory
fn get_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())
}

// Get .atlas directory path
fn get_atlas_dir() -> Result<PathBuf, String> {
    Ok(get_home_dir()?.join(".atlas"))
}

// Create .atlas directory
#[tauri::command]
fn create_atlas_dir() -> IPCResult {
    match get_atlas_dir() {
        Ok(atlas_dir) => {
            if let Err(e) = fs::create_dir_all(&atlas_dir) {
                return IPCResult::error(format!("Failed to create .atlas directory: {}", e));
            }
            IPCResult::success(format!(
                "Atlas directory created at {}",
                atlas_dir.display()
            ))
        }
        Err(e) => IPCResult::error(e),
    }
}

// Check for existing API key in .env
#[tauri::command]
fn check_existing_api_key() -> IPCResult {
    let env_path = match get_atlas_dir() {
        Ok(dir) => dir.join(".env"),
        Err(e) => return IPCResult::error(e),
    };

    if !env_path.exists() {
        return IPCResult {
            success: true,
            message: None,
            error: None,
        };
    }

    match fs::read_to_string(&env_path) {
        Ok(content) => {
            for line in content.lines() {
                if line.trim().starts_with("ATLAS_KEY=") {
                    return IPCResult::success("Existing API key found");
                }
            }
            IPCResult {
                success: true,
                message: None,
                error: None,
            }
        }
        Err(e) => IPCResult::error(format!("Failed to read .env file: {}", e)),
    }
}

// Read .env file as HashMap
fn read_env_file() -> Result<HashMap<String, String>, String> {
    let env_path = get_atlas_dir()?.join(".env");

    if !env_path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&env_path)
        .map_err(|e| format!("Failed to read .env file: {}", e))?;

    let mut env_vars = HashMap::new();

    for line in content.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

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

// Write .env file from HashMap
fn write_env_file(env_vars: HashMap<String, String>) -> Result<(), String> {
    let atlas_dir = get_atlas_dir()?;
    let env_path = atlas_dir.join(".env");

    if !atlas_dir.exists() {
        fs::create_dir_all(&atlas_dir)
            .map_err(|e| format!("Failed to create .atlas directory: {}", e))?;
    }

    let mut sorted_keys: Vec<String> = env_vars.keys().cloned().collect();
    sorted_keys.sort();

    let mut content = String::new();
    for key in sorted_keys {
        let value = env_vars.get(&key).unwrap();

        let formatted_value = if value.contains(' ') || value.contains('\n') || value.contains('\t')
        {
            format!("\"{}\"", value)
        } else {
            value.clone()
        };

        content.push_str(&format!("{}={}\n", key, formatted_value));
    }

    fs::write(&env_path, content).map_err(|e| format!("Failed to write .env file: {}", e))?;

    Ok(())
}

// Save Atlas NPX path - finds the actual full path to npx
#[tauri::command]
async fn save_atlas_npx_path() -> IPCResult {
    tokio::task::spawn_blocking(|| {
        // Find npx using which/where command to get full path
        let npx_name = if cfg!(target_os = "windows") {
            "npx.cmd"
        } else {
            "npx"
        };

        let find_cmd = if cfg!(target_os = "windows") {
            format!("where {}", npx_name)
        } else if cfg!(target_os = "macos") {
            // On macOS, use login shell to get full PATH
            format!("/bin/bash -l -c \"which {}\"", npx_name)
        } else {
            format!("which {}", npx_name)
        };

        // Execute the command to find npx
        let shell = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };

        let shell_flag = if cfg!(target_os = "windows") {
            "/C"
        } else {
            "-c"
        };

        let output = create_hidden_command(shell)
            .args([shell_flag, &find_cmd])
            .output();

        let npx_path = match output {
            Ok(result) if result.status.success() => {
                let path_str = String::from_utf8_lossy(&result.stdout).trim().to_string();
                // On Windows, 'where' might return multiple paths, take the first one
                path_str.lines().next().unwrap_or("").trim().to_string()
            }
            _ => {
                // NPX not found, skip configuration
                return IPCResult {
                    success: true,
                    message: Some("NPX not found, skipping NPX path configuration".to_string()),
                    error: None,
                };
            }
        };

        if npx_path.is_empty() {
            return IPCResult {
                success: true,
                message: Some("NPX not found, skipping NPX path configuration".to_string()),
                error: None,
            };
        }

        // Save to .env with full path
        let mut env_vars = match read_env_file() {
            Ok(vars) => vars,
            Err(e) => return IPCResult::error(e),
        };

        env_vars.insert("ATLAS_NPX_PATH".to_string(), npx_path.clone());

        match write_env_file(env_vars) {
            Ok(_) => IPCResult::success(format!("NPX path saved: {}", npx_path)),
            Err(e) => IPCResult::error(e),
        }
    })
    .await
    .unwrap_or_else(|e| IPCResult::error(format!("Task failed: {}", e)))
}

// Save Atlas API key
#[tauri::command]
fn save_atlas_key(api_key: String) -> IPCResult {
    let mut env_vars = match read_env_file() {
        Ok(vars) => vars,
        Err(e) => return IPCResult::error(e),
    };

    env_vars.insert("ATLAS_KEY".to_string(), api_key);

    match write_env_file(env_vars) {
        Ok(_) => IPCResult::success("API key saved successfully"),
        Err(e) => IPCResult::error(e),
    }
}

// Get EULA text
#[tauri::command]
fn get_eula_text(app: AppHandle) -> Result<String, String> {
    // Try to read from bundled resources first (production)
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Check _up_/eula.txt (bundled from parent directory)
        let eula_path = resource_dir.join("_up_").join("eula.txt");
        if eula_path.exists() {
            return fs::read_to_string(&eula_path).map_err(|e| format!("Failed to read EULA: {}", e));
        }

        // Fallback to root of resources (if bundled differently)
        let eula_path = resource_dir.join("eula.txt");
        if eula_path.exists() {
            return fs::read_to_string(&eula_path).map_err(|e| format!("Failed to read EULA: {}", e));
        }
    }

    // Fallback locations for development (tauri dev runs from src-tauri)
    let fallback_paths = vec![
        PathBuf::from("../eula.txt"),  // Parent directory (app root)
        PathBuf::from("eula.txt"),     // Current directory
    ];

    for path in fallback_paths {
        if path.exists() {
            return fs::read_to_string(&path).map_err(|e| format!("Failed to read EULA: {}", e));
        }
    }

    Err("EULA file not found in any expected location".to_string())
}

// Check if Atlas binary exists
#[derive(serde::Serialize)]
struct BinaryCheckResult {
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
fn check_atlas_binary() -> BinaryCheckResult {
    let binary_name = if cfg!(target_os = "windows") {
        "atlas.exe"
    } else {
        "atlas"
    };

    let binary_path = match get_atlas_dir() {
        Ok(dir) => dir.join("bin").join(binary_name),
        Err(e) => return BinaryCheckResult {
            exists: false,
            path: None,
            error: Some(e),
        },
    };

    if binary_path.exists() {
        BinaryCheckResult {
            exists: true,
            path: Some(binary_path.to_string_lossy().to_string()),
            error: None,
        }
    } else {
        BinaryCheckResult {
            exists: false,
            path: None,
            error: Some("Atlas binary not found".to_string()),
        }
    }
}

// Stop existing Atlas daemon
fn stop_existing_daemon() -> Result<(), String> {
    let binary_name = if cfg!(target_os = "windows") {
        "atlas.exe"
    } else {
        "atlas"
    };

    let binary_path = get_atlas_dir()?.join("bin").join(binary_name);

    // Try to stop using atlas service command - wait for graceful shutdown
    if binary_path.exists() {
        let _ = create_hidden_command(&binary_path.to_string_lossy())
            .args(["service", "stop"])
            .output();

        // Give it time to gracefully shut down
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    // Platform-specific force cleanup only if still running
    if cfg!(target_os = "windows") {
        // Check if process still exists
        let check = create_hidden_command("tasklist")
            .args(["/FI", "IMAGENAME eq atlas.exe"])
            .output();

        let process_running = if let Ok(output) = check {
            String::from_utf8_lossy(&output.stdout).contains("atlas.exe")
        } else {
            false
        };

        // Only force kill if still running after graceful stop
        if process_running {
            let _ = create_hidden_command("taskkill")
                .args(["/F", "/IM", "atlas.exe"])
                .output();

            // Wait for file handles to be released
            std::thread::sleep(std::time::Duration::from_secs(2));

            // Verify process is gone - retry if needed
            for _ in 0..3 {
                let check = create_hidden_command("tasklist")
                    .args(["/FI", "IMAGENAME eq atlas.exe"])
                    .output();

                if let Ok(output) = check {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if !stdout.contains("atlas.exe") {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    } else {
        let _ = create_hidden_command("pkill").args(["-x", "atlas"]).output();
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    Ok(())
}

// Install Atlas binary
#[tauri::command]
async fn install_atlas_binary(app: AppHandle) -> IPCResult {
    // Run in blocking task to prevent UI freeze
    tokio::task::spawn_blocking(move || {
        // Stop existing daemon
        if let Err(e) = stop_existing_daemon() {
            return IPCResult::error(format!("Failed to stop existing daemon: {}", e));
        }

        let bin_dir = match get_atlas_dir() {
            Ok(dir) => dir.join("bin"),
            Err(e) => return IPCResult::error(e),
        };

        if let Err(e) = fs::create_dir_all(&bin_dir) {
            return IPCResult::error(format!("Failed to create bin directory: {}", e));
        }

        let binary_name = if cfg!(target_os = "windows") {
            "atlas.exe"
        } else {
            "atlas"
        };

        // Try resource directory first (production)
        let mut src = PathBuf::new();

        if let Ok(resource_dir) = app.path().resource_dir() {
            // Check _up_/atlas-binary (bundled from parent directory)
            let resource_binary = resource_dir.join("_up_").join("atlas-binary").join(binary_name);
            if resource_binary.exists() {
                src = resource_binary;
            } else {
                // Fallback to root of resources (if bundled differently)
                let resource_binary = resource_dir.join("atlas-binary").join(binary_name);
                if resource_binary.exists() {
                    src = resource_binary;
                }
            }
        }

        // Fallback to development path (tauri dev runs from src-tauri)
        if src.as_os_str().is_empty() {
            let dev_binary = PathBuf::from("../atlas-binary").join(binary_name);
            if dev_binary.exists() {
                src = dev_binary;
            }
        }

        if src.as_os_str().is_empty() || !src.exists() {
            return IPCResult::error("Binary not found. Checked resource dir and ../atlas-binary".to_string());
        }

        let dest = bin_dir.join(binary_name);

        // Copy binary with retry on Windows (file handle may still be held)
        let mut copy_result = fs::copy(&src, &dest);
        if cfg!(target_os = "windows") && copy_result.is_err() {
            // Retry up to 3 times with increasing delays
            for attempt in 1..=3 {
                std::thread::sleep(std::time::Duration::from_secs(attempt));
                copy_result = fs::copy(&src, &dest);
                if copy_result.is_ok() {
                    break;
                }
            }
        }

        if let Err(e) = copy_result {
            return IPCResult::error(format!("Failed to copy binary: {}", e));
        }

        // Set executable permissions on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)) {
                return IPCResult::error(format!("Failed to set permissions: {}", e));
            }
        }

        // Create system symlinks on macOS
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = create_system_symlinks(&bin_dir) {
                // Non-fatal error, just log it
                eprintln!("Symlink creation failed: {}", e);
            }
        }

        // Install web client
        if let Err(e) = install_web_client(&app) {
            eprintln!("Web client installation failed: {}", e);
        }

        // Create Start Menu shortcut on Windows
        if let Err(e) = create_start_menu_shortcut() {
            eprintln!("Shortcut creation warning: {}", e);
        }

        IPCResult::success("Atlas binary installed successfully")
    })
    .await
    .unwrap_or_else(|e| IPCResult::error(format!("Task failed: {}", e)))
}

// Create system symlinks on macOS
#[cfg(target_os = "macos")]
fn create_system_symlinks(bin_dir: &Path) -> Result<(), String> {
    let user_path = bin_dir.join("atlas");
    let system_path = "/usr/local/bin/atlas";

    // Check if symlink already correct
    if let Ok(current) = fs::read_link(system_path) {
        if current == user_path {
            return Ok(());
        }
    }

    // Ensure /usr/local/bin exists
    let _ = Command::new("osascript")
        .args([
            "-e",
            "do shell script \"mkdir -p /usr/local/bin\" with administrator privileges",
        ])
        .output();

    // Create symlink
    let cmd = format!(
        "rm -f {} && ln -sf {} {}",
        system_path,
        user_path.display(),
        system_path
    );

    let output = Command::new("osascript")
        .args([
            "-e",
            &format!(
                "do shell script \"{}\" with administrator privileges",
                cmd
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to create symlink: {}", e))?;

    if !output.status.success() {
        return Err("Symlink creation failed".to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn create_system_symlinks(_bin_dir: &PathBuf) -> Result<(), String> {
    Ok(())
}

// Create Windows Start Menu shortcut
#[cfg(target_os = "windows")]
fn create_start_menu_shortcut() -> Result<(), String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_default();
            home.join("AppData").join("Local").to_string_lossy().to_string()
        });

    let web_client_path = PathBuf::from(&local_app_data)
        .join("Programs")
        .join("Atlas Web Client")
        .join("Atlas Web Client.exe");

    if !web_client_path.exists() {
        // Web client not installed, skip shortcut
        return Ok(());
    }

    let home = get_home_dir()?;
    let shortcut_dir = home
        .join("AppData")
        .join("Roaming")
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");

    let shortcut_path = shortcut_dir.join("Atlas Web Client.lnk");

    // Create shortcut using PowerShell
    let ps_script = format!(
        r#"$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('{}'); $Shortcut.TargetPath = '{}'; $Shortcut.Description = 'Atlas AI Agent Orchestration Platform'; $Shortcut.Save()"#,
        shortcut_path.display(),
        web_client_path.display()
    );

    let output = create_hidden_command("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("Failed to create shortcut: {}", e))?;

    if !output.status.success() {
        eprintln!("Shortcut creation warning: {}", String::from_utf8_lossy(&output.stderr));
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_start_menu_shortcut() -> Result<(), String> {
    Ok(())
}

// Install web client
fn install_web_client(app: &AppHandle) -> Result<(), String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => {
            // Check _up_/atlas-binary (bundled from parent directory)
            let bundled_path = dir.join("_up_").join("atlas-binary");
            if bundled_path.exists() {
                bundled_path
            } else {
                dir.join("atlas-binary")
            }
        },
        Err(_) => PathBuf::from("atlas-binary"),
    };

    #[cfg(target_os = "macos")]
    {
        let app_source = resource_dir.join("Atlas Web Client.app");
        if !app_source.exists() {
            return Ok(()); // Not a fatal error
        }

        let home = get_home_dir()?;
        let user_apps = home.join("Applications");
        fs::create_dir_all(&user_apps)
            .map_err(|e| format!("Failed to create Applications dir: {}", e))?;

        let dest = user_apps.join("Atlas Web Client.app");

        // Remove existing app
        if dest.exists() {
            fs::remove_dir_all(&dest)
                .map_err(|e| format!("Failed to remove old app: {}", e))?;
        }

        // Copy app using cp -R for proper .app bundle handling
        let output = Command::new("cp")
            .args([
                "-R",
                &app_source.display().to_string(),
                &dest.display().to_string(),
            ])
            .output()
            .map_err(|e| format!("Failed to copy web client: {}", e))?;

        if !output.status.success() {
            return Err("Failed to install web client".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let installer_path = resource_dir.join("Atlas Web Client.exe");
        if !installer_path.exists() {
            return Ok(()); // Not a fatal error
        }

        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            get_home_dir()
                .map(|home| format!("{}\\AppData\\Local", home.display()))
                .unwrap_or_else(|_| String::from("C:\\Users\\Public\\AppData\\Local"))
        });
        let install_dir = format!("{}\\Programs\\Atlas Web Client", local_app_data);

        // Run installer silently
        let _ = create_hidden_command(&installer_path.to_string_lossy())
            .args(["/S", &format!("/D={}", install_dir)])
            .output();
    }

    Ok(())
}

// Setup PATH
#[tauri::command]
async fn setup_path() -> IPCResult {
    tokio::task::spawn_blocking(|| {
        let atlas_dir = match get_atlas_dir() {
            Ok(dir) => dir.join("bin"),
            Err(e) => return IPCResult::error(e),
        };

        #[cfg(target_os = "windows")]
        {
            match add_to_windows_path(&atlas_dir) {
                Ok(_) => IPCResult::success(
                    "Atlas has been added to your system PATH.\n\nYou can now use 'atlas' from any new command prompt or PowerShell window."
                ),
                Err(e) => IPCResult::error(e),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match add_to_shell_profiles(&atlas_dir) {
                Ok(_) => IPCResult::success(
                    "Atlas has been added to your shell profiles.\n\nYou can now use 'atlas' from any new terminal window."
                ),
                Err(e) => IPCResult::error(e),
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            IPCResult::error("Unsupported platform")
        }
    })
    .await
    .unwrap_or_else(|e| IPCResult::error(format!("Task failed: {}", e)))
}

// Add to Windows PATH
#[cfg(target_os = "windows")]
fn add_to_windows_path(directory: &std::path::Path) -> Result<(), String> {
    let dir_str = directory.display().to_string();
    let ps_command = format!(
        "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); \
         if ($userPath -notlike '*{}*') {{ \
           [Environment]::SetEnvironmentVariable('Path', $userPath + ';{}', 'User'); \
           $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') \
         }}",
        dir_str, dir_str
    );

    let output = create_hidden_command("powershell")
        .args(["-Command", &ps_command])
        .output()
        .map_err(|e| format!("Failed to update PATH: {}", e))?;

    if !output.status.success() {
        return Err("Failed to add to Windows PATH".to_string());
    }

    Ok(())
}

// Add to shell profiles on macOS
#[cfg(target_os = "macos")]
fn add_to_shell_profiles(directory: &Path) -> Result<(), String> {
    let home = get_home_dir()?;
    let export_line = format!("export PATH=\"{}:$PATH\"\n", directory.display());

    let shell_configs = vec![
        home.join(".zshrc"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
    ];

    for config_file in shell_configs {
        // Create file if it doesn't exist
        if !config_file.exists() {
            fs::write(&config_file, "").ok();
        }

        // Read existing content
        if let Ok(content) = fs::read_to_string(&config_file) {
            // Check if already added
            if content.contains(".atlas/bin") {
                continue;
            }

            // Append export line
            let new_content = if content.ends_with('\n') {
                format!("{}{}", content, export_line)
            } else {
                format!("{}\n{}", content, export_line)
            };

            fs::write(&config_file, new_content).ok();
        }
    }

    Ok(())
}

// Get home directory as string for Tauri
#[tauri::command]
fn get_home_dir_string() -> Result<String, String> {
    dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

// Check if file exists
#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

// Run shell command (for service management)
#[derive(serde::Serialize)]
struct CommandOutput {
    stdout: String,
    stderr: String,
    status: i32,
}

#[tauri::command]
async fn run_command(cmd: String, args: Vec<String>) -> Result<CommandOutput, String> {
    tokio::task::spawn_blocking(move || {
        let output = create_hidden_command(&cmd)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            status: output.status.code().unwrap_or(-1),
        })
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

// Run shell command using sh -c (handles quoting, escaping, etc.)
#[tauri::command]
async fn run_shell_command(command: String) -> Result<CommandOutput, String> {
    tokio::task::spawn_blocking(move || {
        let shell = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };

        let shell_flag = if cfg!(target_os = "windows") {
            "/C"
        } else {
            "-c"
        };

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            // Set working directory to user's home to avoid locking installer directory
            let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\"));

            let output = Command::new(shell)
                .args([shell_flag, &command])
                .current_dir(&home_dir)  // Set working directory to home
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to execute command: {}", e))?;

            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                status: output.status.code().unwrap_or(-1),
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let output = Command::new(shell)
                .args([shell_flag, &command])
                .output()
                .map_err(|e| format!("Failed to execute command: {}", e))?;

            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                status: output.status.code().unwrap_or(-1),
            })
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

// Execute command with elevation (Windows UAC)
#[tauri::command]
async fn execute_elevated_command(command: String) -> Result<CommandOutput, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ffi::OsStr;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
        use windows::core::PCWSTR;

        // Run in blocking task to prevent UI freeze
        tokio::task::spawn_blocking(move || {
            // Create temp files for output capture
            let temp_dir = std::env::temp_dir();
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis();

            let script_path = temp_dir.join(format!("atlas_installer_{}.ps1", timestamp));
            let output_path = temp_dir.join(format!("atlas_installer_{}_out.txt", timestamp));

            // Create PowerShell script that captures output (PowerShell can run truly hidden)
            let ps_content = format!(
                "try {{ {} *>&1 | Out-File -FilePath '{}' -Encoding UTF8; exit $LASTEXITCODE }} catch {{ $_ | Out-File -FilePath '{}' -Encoding UTF8; exit 1 }}",
                command,
                output_path.display(),
                output_path.display()
            );

            fs::write(&script_path, ps_content)
                .map_err(|e| format!("Failed to create temp script: {}", e))?;

            // Build PowerShell arguments with -WindowStyle Hidden to prevent window from showing
            let ps_args = format!(
                "-WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
                script_path.display()
            );

            // Convert to wide strings for Windows API
            let exe_wide: Vec<u16> = OsStr::new("powershell.exe")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let args_wide: Vec<u16> = OsStr::new(&ps_args)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let verb_wide: Vec<u16> = OsStr::new("runas")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            // Execute elevated using ShellExecute with "runas" verb
            unsafe {
                let result = ShellExecuteW(
                    Some(HWND::default()),
                    PCWSTR(verb_wide.as_ptr()),
                    PCWSTR(exe_wide.as_ptr()),
                    PCWSTR(args_wide.as_ptr()),
                    PCWSTR::null(),
                    SW_HIDE,
                );

                // ShellExecute returns > 32 for success
                if result.0 as i32 <= 32 {
                    let _ = fs::remove_file(&script_path);
                    return Err("Failed to execute elevated command (UAC cancelled or error). Please approve the UAC prompt or run installer as Administrator".to_string());
                }
            }

            // Wait for command to complete (check for output file)
            let max_wait = 60; // 60 seconds max
            let mut waited = 0;
            while waited < max_wait && !output_path.exists() {
                std::thread::sleep(std::time::Duration::from_millis(500));
                waited += 1;
            }

            // Give it a moment more for file to be written
            std::thread::sleep(std::time::Duration::from_millis(500));

            // Read output
            let output_content = fs::read_to_string(&output_path)
                .unwrap_or_else(|_| String::from("Command completed but output not captured"));

            // Clean up
            let _ = fs::remove_file(&script_path);
            let _ = fs::remove_file(&output_path);

            Ok(CommandOutput {
                stdout: output_content,
                stderr: String::new(),
                status: 0,
            })
        })
        .await
        .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = command; // Suppress unused warning
        Err("Elevated execution only supported on Windows".to_string())
    }
}

// Get temporary directory as string
#[tauri::command]
fn get_temp_dir_string() -> Result<String, String> {
    std::env::temp_dir()
        .to_str()
        .ok_or_else(|| "Could not determine temp directory".to_string())
        .map(|s| s.to_string())
}

// Create directory
#[tauri::command]
fn create_directory(path: String, recursive: bool) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if recursive {
        fs::create_dir_all(&path_buf)
            .map_err(|e| format!("Failed to create directory: {}", e))
    } else {
        fs::create_dir(&path_buf)
            .map_err(|e| format!("Failed to create directory: {}", e))
    }
}

// Remove file
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    fs::remove_file(&path_buf)
        .map_err(|e| format!("Failed to remove file: {}", e))
}

// Write file
#[tauri::command]
fn write_file(path: String, content: String, is_binary: bool) -> Result<(), String> {
    let path_buf = PathBuf::from(path);

    if is_binary {
        // Decode base64 content
        use base64::{Engine as _, engine::general_purpose};
        let bytes = general_purpose::STANDARD.decode(&content)
            .map_err(|e| format!("Failed to decode base64: {}", e))?;
        fs::write(&path_buf, bytes)
            .map_err(|e| format!("Failed to write file: {}", e))
    } else {
        fs::write(&path_buf, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    }
}

// Run shell command with DETACHED_PROCESS (for commands that spawn background processes)
#[tauri::command]
async fn run_shell_command_visible(command: String) -> Result<CommandOutput, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x00000008;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            // Set working directory to user's home to avoid locking installer directory
            let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\"));

            // Use DETACHED_PROCESS to allow child process spawning while hiding window
            let output = Command::new("cmd")
                .args(["/C", &command])
                .current_dir(&home_dir)  // Set working directory to home
                .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to execute command: {}", e))?;

            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                status: output.status.code().unwrap_or(-1),
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let output = Command::new("sh")
                .args(["-c", &command])
                .output()
                .map_err(|e| format!("Failed to execute command: {}", e))?;

            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                status: output.status.code().unwrap_or(-1),
            })
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

// Removed manage_atlas_service - using TypeScript implementation instead

// Launch Atlas Web Client
#[tauri::command]
async fn launch_web_client() -> IPCResult {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let home = match get_home_dir() {
                Ok(h) => h,
                Err(e) => return IPCResult::error(e),
            };

            let user_app = home.join("Applications").join("Atlas Web Client.app");
            let system_app = PathBuf::from("/Applications/Atlas Web Client.app");

            // Try user Applications first
            let app_to_launch = if user_app.exists() {
                user_app
            } else if system_app.exists() {
                system_app
            } else {
                return IPCResult::error("Atlas Web Client not found. Please launch it manually from Applications.");
            };

            // Use spawn() to fully detach the process
            let result = Command::new("open")
                .arg(&app_to_launch)
                .spawn();

            match result {
                Ok(_) => IPCResult::success("Atlas Web Client launched"),
                Err(_) => IPCResult::error("Failed to launch Atlas Web Client"),
            }
        }

        #[cfg(target_os = "windows")]
        {
            let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                get_home_dir()
                    .map(|home| format!("{}\\AppData\\Local", home.display()))
                    .unwrap_or_else(|_| String::from("C:\\Users\\Public\\AppData\\Local"))
            });

            let exe_path = format!("{}\\Programs\\Atlas Web Client\\Atlas Web Client.exe", local_app_data);

            if !PathBuf::from(&exe_path).exists() {
                return IPCResult::error(format!("Atlas Web Client not found at: {}", exe_path));
            }

            // Use PowerShell Start-Process to properly launch GUI application
            // This is more reliable than cmd /C start for paths with spaces
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let ps_command = format!("Start-Process -FilePath '{}' -WindowStyle Normal", exe_path);

            let result = Command::new("powershell")
                .args(["-WindowStyle", "Hidden", "-Command", &ps_command])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();

            match result {
                Ok(_) => IPCResult::success("Atlas Web Client launched"),
                Err(e) => IPCResult::error(format!("Failed to launch Atlas Web Client: {}", e)),
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            IPCResult::error("Launching web client is only supported on macOS and Windows")
        }
    })
    .await
    .unwrap_or_else(|e| IPCResult::error(format!("Task failed: {}", e)))
}

// Quit the application
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_platform,
            get_home_dir_string,
            get_temp_dir_string,
            file_exists,
            create_directory,
            remove_file,
            write_file,
            create_atlas_dir,
            check_existing_api_key,
            save_atlas_npx_path,
            save_atlas_key,
            install_atlas_binary,
            check_atlas_binary,
            setup_path,
            run_command,
            run_shell_command,
            run_shell_command_visible,
            execute_elevated_command,
            get_eula_text,
            launch_web_client,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
