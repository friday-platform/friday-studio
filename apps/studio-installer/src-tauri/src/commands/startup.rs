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

// Snapshot/contains tests for the rendered shell. Each load-bearing token
// in the awk parser, the brace-escaped defaults, and the no-hardcoded-port
// invariant is asserted explicitly so a future refactor that mangles the
// `format!()` output (or reverts a security fix) fails `cargo test` instead
// of silently misbehaving at LaunchAgent time on a user's machine.
//
// Pattern mirrors apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs.
#[cfg(test)]
mod tests {
    #[cfg(unix)]
    mod unix {
        use super::super::generate_unix_script;

        const TEST_INSTALL_DIR: &str = "/test/install/dir";

        fn rendered() -> String {
            generate_unix_script(TEST_INSTALL_DIR)
        }

        #[test]
        fn awk_parser_load_bearing_tokens_present() {
            let s = rendered();
            // Field separator. Typo to `-F:` silently captures nothing and
            // every port falls through to default — invisible 30s LaunchAgent
            // stall on every login.
            assert!(s.contains("awk -F="), "awk -F= delimiter missing");
            // length(k)+2 skips "KEY=" exactly. Off-by-one to +1 truncates the
            // first char of every value (port "8080" becomes "080").
            assert!(
                s.contains("substr($0, length(k)+2)"),
                "substr math missing or changed",
            );
            // CRLF strip. Without it, a Windows-edited .env silently breaks
            // numeric port comparisons (the value would have a trailing \r).
            assert!(s.contains("tr -d '\\r'"), "tr -d '\\r' missing");
            // Exact match, not regex. Regression to `~` would make
            // FRIDAY_PORT_FRIDAY_DEV match FRIDAY_PORT_FRIDAY silently.
            assert!(s.contains("$1==k{"), "exact-match guard missing");
        }

        #[test]
        fn dot_source_not_reintroduced() {
            let s = rendered();
            // The whole point of the awk swap was to eliminate dot-sourcing
            // arbitrary shell content from a user-writable .env file. Catch
            // any refactor that re-introduces it.
            assert!(
                !s.contains(". \"$FRIDAY_HOME/.env\""),
                "dot-source of .env reintroduced",
            );
            assert!(!s.contains("set -a"), "set -a (autoexport) reintroduced");
        }

        #[test]
        fn three_port_keys_extracted() {
            let s = rendered();
            for key in &[
                "read_env_value FRIDAY_PORT_FRIDAY",
                "read_env_value FRIDAY_PORT_LINK",
                "read_env_value FRIDAY_PORT_PLAYGROUND",
            ] {
                assert!(s.contains(key), "missing extraction call: {key}");
            }
        }

        #[test]
        fn defaults_render_with_correct_brace_escapes() {
            let s = rendered();
            // `${{...}}` in Rust format!() must render as `${...}` in bash.
            // Anchor the literal fallback strings — a brace-escape regression
            // would render as e.g. `{PORT_FRIDAY:-8080}` (broken bash).
            for default in &[
                "${PORT_FRIDAY:-8080}",
                "${PORT_LINK:-3100}",
                "${PORT_PLAYGROUND:-5200}",
            ] {
                assert!(s.contains(default), "missing fallback default: {default}");
            }
        }

        #[test]
        fn probes_use_resolved_vars_not_hardcoded_ports() {
            let s = rendered();
            // Positive: probes reference the resolved $PORT_* vars.
            assert!(s.contains(r#"http://localhost:$PORT_FRIDAY/health"#));
            assert!(s.contains(r#"http://localhost:$PORT_LINK/health"#));
            assert!(s.contains(r#"nc -z localhost "$PORT_PLAYGROUND""#));
            assert!(s.contains(r#"open "http://localhost:$PORT_PLAYGROUND""#));
            // Negative: catch the specific regression shapes — a hardcoded
            // port appearing in a probe URL or browser-open. Substring counts
            // don't work because comments mention :8080 / 18080 in prose.
            assert!(
                !s.contains(":8080/health"),
                "hardcoded :8080/health probe — must use $PORT_FRIDAY",
            );
            assert!(
                !s.contains(":3100/health"),
                "hardcoded :3100/health probe — must use $PORT_LINK",
            );
            assert!(
                !s.contains("localhost 5200"),
                "hardcoded `nc -z localhost 5200` — must use $PORT_PLAYGROUND",
            );
            assert!(
                !s.contains(":5200\""),
                "hardcoded :5200 in URL — must use $PORT_PLAYGROUND",
            );
        }

        #[test]
        fn install_dir_substituted_into_binary_paths() {
            let s = rendered();
            for path in &[
                "\"/test/install/dir/atlas\"",
                "\"/test/install/dir/link\"",
                "\"/test/install/dir/agent-playground\"",
                "\"/test/install/dir/webhook-tunnel\"",
            ] {
                assert!(s.contains(path), "missing binary invocation: {path}");
            }
        }
    }

    #[cfg(windows)]
    mod windows {
        use super::super::generate_windows_script;

        const TEST_INSTALL_DIR: &str = r"C:\test\install";

        fn rendered() -> String {
            generate_windows_script(TEST_INSTALL_DIR)
        }

        #[test]
        fn tokens_uses_star_not_2() {
            let s = rendered();
            // tokens=1,* captures everything after the first `=` in %%b,
            // preserving values that contain `=` (URLs etc.). Regression to
            // tokens=1,2 truncates at the next `=` — that EXACT bug was
            // introduced and fixed in this PR; keep it from coming back.
            assert!(
                s.contains("tokens=1,* delims=="),
                "tokens=1,* missing — values with `=` will be truncated",
            );
            assert!(!s.contains("tokens=1,2"), "tokens=1,2 reintroduced");
        }

        #[test]
        fn three_port_keys_matched() {
            let s = rendered();
            for matcher in &[
                r#"if "%%a"=="FRIDAY_PORT_FRIDAY""#,
                r#"if "%%a"=="FRIDAY_PORT_LINK""#,
                r#"if "%%a"=="FRIDAY_PORT_PLAYGROUND""#,
            ] {
                assert!(s.contains(matcher), "missing key matcher: {matcher}");
            }
        }

        #[test]
        fn probes_use_resolved_vars_not_hardcoded_ports() {
            let s = rendered();
            // Positive: probes reference the resolved %PORT_*% vars.
            assert!(s.contains("http://localhost:%PORT_FRIDAY%/health"));
            assert!(s.contains("http://localhost:%PORT_LINK%/health"));
            assert!(s.contains("Connect('localhost', %PORT_PLAYGROUND%)"));
            assert!(s.contains("http://localhost:%PORT_PLAYGROUND%"));
            // Negative: substring counts don't work (comments mention these
            // ports), so anchor on the specific regression shapes.
            assert!(
                !s.contains(":8080/health"),
                "hardcoded :8080/health probe — must use %PORT_FRIDAY%",
            );
            assert!(
                !s.contains(":3100/health"),
                "hardcoded :3100/health probe — must use %PORT_LINK%",
            );
            assert!(
                !s.contains("Connect('localhost', 5200)"),
                "hardcoded Connect('localhost', 5200) — must use %PORT_PLAYGROUND%",
            );
            assert!(
                !s.contains(":5200\""),
                "hardcoded :5200 in URL — must use %PORT_PLAYGROUND%",
            );
        }

        #[test]
        fn install_dir_substituted_into_binary_paths() {
            let s = rendered();
            for path in &[
                r#""C:\test\install\atlas.exe""#,
                r#""C:\test\install\link.exe""#,
                r#""C:\test\install\agent-playground.exe""#,
                r#""C:\test\install\webhook-tunnel.exe""#,
            ] {
                assert!(s.contains(path), "missing binary invocation: {path}");
            }
        }
    }
}
