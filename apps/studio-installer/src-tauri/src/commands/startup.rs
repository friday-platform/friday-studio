use std::fs;
use std::path::PathBuf;

fn scripts_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".friday").join("local").join("scripts"))
}

#[cfg(unix)]
fn generate_unix_script(install_dir: &str) -> String {
    format!(
        r#"#!/bin/bash
export FRIDAY_HOME="$HOME/.friday/local"

mkdir -p "$FRIDAY_HOME/pids"

# Read the launcher's .env so health probes hit the right ports when the
# user has FAST/LINK_DEV overrides (FRIDAY_PORT_FRIDAY=18080, etc.). LaunchAgent
# starts this script in a clean env, so without this we'd silently poll :8080
# while atlas listens on a different port and time out for 30s on every login.
#
# Use awk rather than `. .env` (dot-source) — the launcher writes .env values
# unquoted, so a user-pasted secret containing $ or backticks would be expanded
# at every login. awk reads the file as plain strings; no shell metacharacters
# are interpreted. We only extract the three port keys; other vars (atlas etc.
# read .env themselves on startup, so the script doesn't need to re-export).
read_env_value() {{
  awk -F= -v k="$1" '$1==k{{print substr($0, length(k)+2); exit}}' "$FRIDAY_HOME/.env" 2>/dev/null | tr -d '\r'
}}

if [ -f "$FRIDAY_HOME/.env" ]; then
  PORT_FRIDAY=$(read_env_value FRIDAY_PORT_FRIDAY)
  PORT_LINK=$(read_env_value FRIDAY_PORT_LINK)
  PORT_PLAYGROUND=$(read_env_value FRIDAY_PORT_PLAYGROUND)
fi
PORT_FRIDAY="${{PORT_FRIDAY:-8080}}"
PORT_LINK="${{PORT_LINK:-3100}}"
PORT_PLAYGROUND="${{PORT_PLAYGROUND:-5200}}"

# Phase 1 — backends
nohup "{install_dir}/atlas" >> "$FRIDAY_HOME/atlas.log" 2>&1 &
echo $! > "$FRIDAY_HOME/pids/atlas.pid"

nohup "{install_dir}/link" >> "$FRIDAY_HOME/link.log" 2>&1 &
echo $! > "$FRIDAY_HOME/pids/link.pid"

# Wait for backends
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT_FRIDAY/health" > /dev/null 2>&1 && break
  sleep 1
done

for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT_LINK/health" > /dev/null 2>&1 && break
  sleep 1
done

# Phase 2 — frontends
nohup "{install_dir}/agent-playground" >> "$FRIDAY_HOME/agent-playground.log" 2>&1 &
echo $! > "$FRIDAY_HOME/pids/agent-playground.pid"

nohup "{install_dir}/webhook-tunnel" >> "$FRIDAY_HOME/webhook-tunnel.log" 2>&1 &
echo $! > "$FRIDAY_HOME/pids/webhook-tunnel.pid"

# Wait for Studio port
for i in $(seq 1 30); do
  nc -z localhost "$PORT_PLAYGROUND" 2>/dev/null && break
  sleep 1
done

open "http://localhost:$PORT_PLAYGROUND"
"#,
        install_dir = install_dir
    )
}

#[cfg(windows)]
fn generate_windows_script(install_dir: &str) -> String {
    format!(
        r#"@echo off
set FRIDAY_HOME=%USERPROFILE%\.friday\local
mkdir "%FRIDAY_HOME%\pids" 2>nul

REM Load the launcher's .env so health probes hit the right ports when the
REM user has FAST/LINK_DEV overrides (FRIDAY_PORT_FRIDAY=18080, etc.). The
REM scheduled task starts this script in a clean env, so without this we'd
REM silently poll :8080 while atlas listens on a different port.
REM
REM `tokens=1,*` (not `1,2`) captures everything after the first `=` in %%b,
REM so URL-shaped values aren't truncated at internal `=` characters. cmd.exe's
REM `for /f` reads the file as plain text — no shell expansion of the contents
REM — but we only consume the three known FRIDAY_PORT_* keys to keep the
REM blast radius bounded if .env grows new vars later.
set "PORT_FRIDAY=8080"
set "PORT_LINK=3100"
set "PORT_PLAYGROUND=5200"
if exist "%FRIDAY_HOME%\.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%FRIDAY_HOME%\.env") do (
        if "%%a"=="FRIDAY_PORT_FRIDAY" set "PORT_FRIDAY=%%b"
        if "%%a"=="FRIDAY_PORT_LINK" set "PORT_LINK=%%b"
        if "%%a"=="FRIDAY_PORT_PLAYGROUND" set "PORT_PLAYGROUND=%%b"
    )
)

REM Phase 1 — backends
start /B "" "{install_dir}\atlas.exe" >> "%FRIDAY_HOME%\atlas.log" 2>&1
for /f %%i in ('powershell -command "Get-Process -Name atlas | Select-Object -Last 1 -ExpandProperty Id"') do echo %%i > "%FRIDAY_HOME%\pids\atlas.pid"

start /B "" "{install_dir}\link.exe" >> "%FRIDAY_HOME%\link.log" 2>&1
for /f %%i in ('powershell -command "Get-Process -Name link | Select-Object -Last 1 -ExpandProperty Id"') do echo %%i > "%FRIDAY_HOME%\pids\link.pid"

REM Wait for backends
:wait_atlas
powershell -command "try {{ Invoke-WebRequest -Uri http://localhost:%PORT_FRIDAY%/health -UseBasicParsing -ErrorAction Stop | Out-Null; exit 0 }} catch {{ exit 1 }}"
if errorlevel 1 (
    timeout /t 1 /nobreak > nul
    goto wait_atlas
)

:wait_link
powershell -command "try {{ Invoke-WebRequest -Uri http://localhost:%PORT_LINK%/health -UseBasicParsing -ErrorAction Stop | Out-Null; exit 0 }} catch {{ exit 1 }}"
if errorlevel 1 (
    timeout /t 1 /nobreak > nul
    goto wait_link
)

REM Phase 2 — frontends
start /B "" "{install_dir}\agent-playground.exe" >> "%FRIDAY_HOME%\agent-playground.log" 2>&1
start /B "" "{install_dir}\webhook-tunnel.exe" >> "%FRIDAY_HOME%\webhook-tunnel.log" 2>&1

REM Wait for Studio port and open browser
:wait_studio
powershell -command "(New-Object System.Net.Sockets.TcpClient).Connect('localhost', %PORT_PLAYGROUND%)"
if errorlevel 1 (
    timeout /t 1 /nobreak > nul
    goto wait_studio
)

start "" "http://localhost:%PORT_PLAYGROUND%"
"#,
        install_dir = install_dir
    )
}

#[tauri::command]
pub fn create_startup_script(install_dir: String) -> Result<String, String> {
    let scripts = scripts_dir()?;
    fs::create_dir_all(&scripts)
        .map_err(|e| format!("Failed to create scripts dir: {e}"))?;

    #[cfg(unix)]
    {
        let script_path = scripts.join("start-studio.sh");
        let content = generate_unix_script(&install_dir);
        fs::write(&script_path, content.as_bytes())
            .map_err(|e| format!("Failed to write startup script: {e}"))?;

        // Make executable
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| format!("Cannot stat script: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("Cannot chmod script: {e}"))?;

        Ok(script_path.to_string_lossy().into_owned())
    }

    #[cfg(windows)]
    {
        let script_path = scripts.join("start-studio.bat");
        let content = generate_windows_script(&install_dir);
        fs::write(&script_path, content.as_bytes())
            .map_err(|e| format!("Failed to write startup script: {e}"))?;
        Ok(script_path.to_string_lossy().into_owned())
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("Unsupported platform for startup script generation".to_string())
    }
}
