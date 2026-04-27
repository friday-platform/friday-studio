<!-- v7 - 2026-04-23 - Generated via /improving-plans from docs/plans/2026-04-23-studio-installer-design.v6.md -->

# Friday Studio Installer — Design

## Problem Statement

Installing Friday Studio requires manually downloading a 1GB+ binary, unpacking it to the right location, configuring API keys, writing startup scripts for five separate processes, and knowing how to launch them. There is no guided experience, no progress feedback for the large download, and no safety net for partial downloads or missing configuration. First-time users have no clear path from "I have a download link" to "Studio is running in my browser."

## Solution

A Tauri 2.x desktop installer app (`apps/studio-installer`) that guides users through a linear step flow, handles the large binary download with resume/retry support, collects at least one API key before downloading, verifies the checksum, unpacks to the OS-correct location, writes a startup script, and opens the browser to Studio once everything is running. Ships as a signed `.dmg` on macOS and a self-signed `.exe` on Windows, built in CI via GitHub Actions.

The installer also doubles as the **updater**: re-running it detects an existing installation, compares the installed version against the manifest, stops any running Studio processes, overwrites the binaries, and relaunches. If Studio is already running and up to date, the installer short-circuits to a single "Open Studio" button. Studio itself shows a passive update-available banner (linking back to the installer download page) but does not self-update.

Frontend: plain Svelte 5 + TypeScript (not SvelteKit — the installer is a linear flow with no routing, so the SvelteKit overhead adds nothing).

## Branding

The installer uses the existing Friday brand assets from `apps/friday-website/src/lib/assets/`:

- **`favicon.svg`** — the standalone blue mark. Used as the Tauri app icon. Must be converted to `.icns` (macOS) and `.ico` (Windows) for `tauri.conf.json`'s `bundle.icon` array. The SVG viewBox is already square — straightforward conversion.
- **`logo.svg`** — the full wordmark (blue mark + "Friday" text). Used as the header image on the Welcome screen.
- **`logo-grey.svg`** — grey variant, suitable for disabled/secondary states in the UI.

The icon conversion is a one-time build step. Store the generated `.icns`/`.ico` under `src-tauri/icons/` alongside Tauri's default icon set.

## User Stories

1. As a new Friday Studio user, I want a guided installer UI, so that I don't have to manually download, unpack, and configure anything.
2. As a user, I want to read and accept the license before installation begins, so that I understand the terms before committing.
3. As a user, I want to scroll through the full license text before the Accept button enables, so that I can't accidentally skip it.
4. As a user, I want to provide my Anthropic or OpenAI API key before downloading, so that I find out early if I don't have one — not after waiting for a 1GB download.
5. As a user, I want to be able to provide both API keys, so that Studio can use whichever one I prefer.
6. As a user, I want the installer to refuse to continue unless at least one key is provided, so that Studio will actually work after installation.
7. As a user, I want the installer to not overwrite API keys I already configured, so that reinstalling doesn't break my existing setup.
8. As a user, I want a visible download progress bar with speed and estimated time remaining, so that I know the download is working and roughly when it will finish.
9. As a user on a slow or unstable connection, I want the download to automatically retry and resume from where it left off, so that I don't have to restart from zero after a network hiccup.
10. As a user, I want a manual "Try again" button if the download fails after all automatic retries, so that I stay in control.
11. As a user, I want the installer to verify the downloaded file's checksum before unpacking, so that I don't install a corrupted binary.
12. As a user, I want the installer to tell me clearly if the checksum fails and offer to re-download, so that I'm not left with a broken installation silently.
13. As a user on macOS, I want Friday Studio installed in `/Applications`, so that it behaves like any other Mac app.
14. As a user on macOS, I want Friday Studio to be searchable in Spotlight after installation, so that I can launch it without hunting for the icon.
15. As a user on Windows, I want Friday Studio installed in the standard Programs location, so that it integrates with Add/Remove Programs.
16. As a user on Windows, I want a desktop shortcut created automatically, so that I can launch Studio without navigating to the install folder.
17. As a user on Windows, I want a Start Menu entry created, so that Studio appears alongside my other apps.
18. As a user, I want a startup script generated automatically, so that I can launch all five Studio processes with a single command.
19. As a user, I want the startup script to wait for Studio to be ready before opening my browser, so that I don't land on a "connection refused" page.
20. As a user, I want the browser to open automatically to Studio's UI after launch, so that I don't have to remember the port.
21. As a user, I want the installer to detect my OS and CPU architecture automatically, so that I always download the right binary.
22. As a user, I want the installer to fetch the latest version from a manifest, so that I always get the current release without the installer itself needing to be updated.
23. As a macOS user, I want the installer to be signed and notarized by Apple, so that Gatekeeper doesn't block it.
24. As a Windows user, I want the installer to be signed, so that I get a consistent installation experience (SmartScreen warning acceptable for now with self-signed cert).
25. As a returning user who already has Studio installed, I want the installer to detect my existing `.env` and preserve my keys, so that reinstalling is safe.
26. As a returning user running the installer again, I want it to detect that Studio is already installed and show me the installed vs available version, so that I know whether an update is needed.
27. As a returning user, I want the installer to stop any running Studio processes before overwriting binaries, so that the update doesn't corrupt a live installation.
28. As a returning user, I want the License and API key steps skipped on update, so that I'm not re-prompted for things I already accepted and configured.
29. As a Studio user, I want to see a banner inside Studio when a newer version is available, so that I know to run the installer again without having to check manually.
30. As a user who opens the installer when Studio is already running and up to date, I want to be offered a direct "Open Studio" button, so that the installer acts as a launcher and I don't need to find the URL myself.
31. As a beta user with a newer version than the public stable release, I want the installer to recognise I'm already ahead and not attempt a downgrade, so that I don't accidentally lose my beta build.

## Implementation Decisions

### Project location

`apps/studio-installer` in the Atlas monorepo. Intended to move to a dedicated repository at a later date; the internal structure is self-contained so extraction is straightforward.

### Step flow

**Fresh install:**
```
Welcome → License (scroll-to-accept) → API Keys → Download + Verify → Extract → Launch
```

**Update (existing install, newer version available, Studio not running):**
```
Welcome (shows "v1.0.0 → v1.2.0") → Download + Verify → Extract → Launch
```

**Update (Studio is running):**
```
Welcome (shows "v1.0.0 → v1.2.0 — Studio is running, update will stop it") →
  [Update] → Download + Verify → Extract → Launch
  [Open Studio instead] → open browser, close installer
```

**Already current (Studio running) — includes beta ≥ stable case:**
```
Welcome ("You're on the latest version") → [Open Studio] → open browser, close installer
```

**Already current (Studio not running):**
```
Welcome ("You're on the latest version") → [Launch Studio] → Launch → browser opens
```

License and API key steps are always skipped on update/current flows: license was already accepted (marker file present) and existing keys are preserved by `env_file.rs`.

On startup, `installer.ts` calls `fetch_manifest` (10s timeout) then reads `~/.friday/local/.installed` via `read_installed`, calls `check_running_processes()`, and branches to the appropriate flow. Version comparison uses semver ordering — `installed >= available` maps to `current`, `installed < available` maps to `update`. This means a beta user on v1.1.0-beta with a stable manifest at v1.0.0 sees "You're on the latest version" and is never sent into the update/downgrade flow.

Collecting API keys before the download means first-time users discover missing credentials in ~10 seconds instead of after a multi-minute download.

### Module Boundaries

**`src-tauri/src/commands/download.rs`**
- **Interface:** `download_file(url, dest, on_progress: Channel<DownloadEvent>)` — Tauri command. Uses a typed Channel (not loose events) for ordered, high-throughput progress streaming. `DownloadEvent` is a tagged union: `Progress { downloaded, total, bytes_per_sec }` | `Done` | `Error { message }`.
- **Hides:** HTTP Range resume logic, chunk streaming, retry backoff schedule, partial file management, reqwest client lifecycle.
- **Trust contract:** Caller provides a channel callback; receives ordered progress messages and a terminal `Done` or `Error`. Retry/resume is fully automatic up to 5 attempts; on exhaustion sends `Error` through the channel. The command does not delete the partial on failure — that is the caller's responsibility via `delete_partial`. The command does not write the `.complete` marker — that is the caller's responsibility via `mark_download_complete` after a successful `Done` event.

**`src-tauri/src/commands/delete_partial.rs`**
- **Interface:** `delete_partial(platform: String)` → `Result<(), String>`
- **Hides:** Partial file path construction (`{tmp_dir}/friday-studio-{platform}.partial`), complete marker path (`{tmp_dir}/friday-studio-{platform}.complete`), existence check before delete (idempotent for both files).
- **Trust contract:** After call, neither the `.partial` nor the `.complete` file exists for the given platform — download state is fully reset. Safe to call when either or both files are absent. `installer.ts` calls this after `verify_sha256` returns `false` (corrupt download) before re-invoking `download_file`.

**`src-tauri/src/commands/download_checkpoint.rs`**
- **Interface:** `mark_download_complete(platform: String) → Result<(), String>`, `check_download_complete(platform: String) → Result<bool, String>`
- **Hides:** Complete marker path (`{tmp_dir}/friday-studio-{platform}.complete`), file existence check.
- **Trust contract:** `mark_download_complete` writes the `.complete` marker. `check_download_complete` returns `true` only if the `.complete` file exists. Both are idempotent. The `.complete` marker is invalidated by `delete_partial` — a single `delete_partial` call fully resets all download state. `installer.ts` uses `check_download_complete` instead of `localStorage` to skip re-download on reopening; calls `mark_download_complete` after receiving the `Done` event from `download_file` and before invoking `verify_sha256`.

**`src-tauri/src/commands/verify.rs`**
- **Interface:** `verify_sha256(path, expected_hash)` → `Result<bool, String>`
- **Hides:** Streaming file read, SHA256 accumulation (never loads 1GB into memory).
- **Trust contract:** Returns `true` only on exact match. On mismatch returns `Ok(false)`. On IO error returns `Err`. Checksum failure (`Ok(false)`) is a caller signal to call `delete_partial` before retrying.

**`src-tauri/src/commands/extract.rs`**
- **Interface:** `extract_archive(src, dest)` → `Result<(), String>`
- **Hides:** Format detection (`.tar.gz` on macOS, `.zip` on Windows), OS-appropriate unpack path resolution. On update: reads `~/.friday/local/pids/` to find running Studio processes and sends SIGTERM (macOS) / `TerminateProcess` (Windows) before extracting; waits up to 10s for clean exit, then SIGKILL. On Windows, running executables cannot be overwritten — process termination is mandatory, not optional. **Backup strategy:** before extracting on update, checks for a pre-existing `.bak` directory (left by a previously crashed extraction) and removes it if found, then renames the current install dir to `Friday Studio.app.bak` (macOS) or `Friday Studio.bak` (Windows). Deletes backup on success. Restores backup on extraction failure, then returns `Err`.
- **Trust contract:** On success, binaries are at the canonical install path for the current platform and no Studio processes are running. On failure (extraction error or failed process termination), existing install is restored from backup — the system is never left in a partially-updated state. If a stale `.bak` from a previous failed extraction is present, it is removed before creating a new backup — a stale `.bak` is superseded the moment the user retries the update. Fresh install and update use the same interface; caller does not need to know which case applies.

**`src-tauri/src/commands/check_running.rs`**
- **Interface:** `check_running_processes()` → `Result<bool, String>`
- **Hides:** PID file enumeration from `~/.friday/local/pids/`, process existence check per PID (kill -0 on macOS, `OpenProcess` on Windows), stale PID file cleanup (removes PID file if process no longer exists).
- **Trust contract:** Returns `true` if any Studio process is currently running. Returns `false` if all PID files are stale or pids/ directory is absent. Safe to call at any time; does not terminate processes.

**`src-tauri/src/commands/fetch_manifest.rs`**
- **Interface:** `fetch_manifest(url: String)` → `Result<Manifest, String>` where `Manifest = { version: String, platforms: Map<String, PlatformEntry> }`.
- **Hides:** reqwest HTTP GET with 10-second total timeout, JSON deserialization, error message formatting for timeout vs network vs parse failures.
- **Trust contract:** Returns `Err` with a human-readable message on any failure (timeout, DNS, parse). Caller (`installer.ts`) shows this message with a Retry button. Never hangs longer than 10s.

**`src-tauri/src/commands/installed_marker.rs`**
- **Interface:** `write_installed(version: String) → Result<(), String>`, `read_installed() → Result<Option<InstalledMarker>, String>` where `InstalledMarker = { version: String, installed_at: String }`.
- **Hides:** Path resolution (`~/.friday/local/.installed`), atomic write (write to `.installed.tmp`, `fs::rename()` to `.installed` — atomic on same filesystem), directory creation. On read: JSON parse errors are caught, the corrupted file is deleted, and `None` is returned (treated as absent).
- **Trust contract:** `write_installed` never leaves a partially-written marker — either the rename succeeds atomically or the `.tmp` file is left behind (safe to ignore on next startup). `read_installed` never returns a parse error to the caller; a corrupted file is self-healing (deleted + returns `None`). `None` means "no prior install detected."

**`src-tauri/src/commands/env_file.rs`**
- **Interface:** `write_env_file(anthropic_key?, openai_key?)` → `Result<(), String>`
- **Hides:** Path resolution (`~/.friday/local/.env` / `%USERPROFILE%\.friday\local\.env`), existing-file parse, merge logic (never overwrites a present key), directory creation. Writes **two categories** of vars, both merge-preserved:
  1. **User API keys** — `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the function arguments (written only if non-empty and not already present).
  2. **Platform-internal vars** — written if not already present in the file:
     - `ATLAS_LOCAL_ONLY=true`
     - `LINK_DEV_MODE=true`
     - `ATLAS_KEY=<fixed_jwt>` — the local JWT is a compile-time constant generated in Rust: base64url(`{"alg":"HS256","typ":"JWT"}`) + "." + base64url(`{"sub":"local-user"}`) + ".local". No Node.js dependency.
     - `ATLASD_URL=http://localhost:8080`
     - `VITE_EXTERNAL_DAEMON_URL=http://localhost:8080`
     - `VITE_EXTERNAL_TUNNEL_URL=http://localhost:9090`
- **Trust contract:** After call, `$FRIDAY_HOME/.env` contains all platform-internal vars and any provided user keys. Pre-existing values (any var already in the file) are never overwritten — safe to call on reinstall or update without losing customisation. Apps read this file directly at startup using `FRIDAY_HOME`; the installer does not inject these vars at process-spawn time.

**`src-tauri/src/commands/startup.rs`**
- **Interface:** `create_startup_script(install_dir)` → `Result<String, String>` (returns script path)
- **Hides:** Platform-appropriate script format (`.sh` with `nohup` on macOS/Linux, `.bat` with `start /B` on Windows), PID file location (`~/.friday/local/pids/`), binary path construction from install dir, proper quoting of paths containing spaces (e.g. `"Friday Studio"` on Windows).
- **Trust contract:** Script at returned path, when executed, starts all five Studio processes in the correct two-phase order and is idempotent. The generated script sets **one environment variable** before starting processes:
  - `FRIDAY_HOME=~/.friday/local/` (macOS) / `FRIDAY_HOME=%USERPROFILE%\.friday\local\` (Windows)

  Apps read their full configuration — both user API keys and platform-internal vars — from `$FRIDAY_HOME/.env` at startup. The script does not hardcode platform-internal vars or generate `ATLAS_KEY` at runtime; all configuration lives in the env file written by `env_file.rs` during installation.

  All paths in the script are quoted to handle the `Friday Studio` space in the install directory name. See `docker/run-platform.sh` as the reference for the startup sequence and two-phase ordering.

**`src-tauri/src/commands/launch.rs`**
- **Interface:** `launch_studio(install_dir: String)` → `Result<(), String>`
- **Hides:** Direct `std::process::Command` spawning of all five processes in two ordered phases using `install_dir`. Sets `FRIDAY_HOME` to the platform-appropriate `~/.friday/local/` path for all spawned processes — apps read their configuration from `$FRIDAY_HOME/.env` directly. After spawning each process, calls `child.try_wait()` after 100ms to catch immediate exits. Conducts backend health polling before starting frontend processes. Finally polls port 5200 as overall liveness gate. `tauri-plugin-opener` call to open browser.
- **Startup sequence:**
  - **Phase 1 — backends:** spawn `atlas` (daemon, port 8080) → `try_wait(100ms)` → write `~/.friday/local/pids/atlas.pid` → spawn `link` (port 3100) → `try_wait(100ms)` → write `pids/link.pid` → poll `http://localhost:8080/health` up to 30s → poll `http://localhost:3100/health` up to 30s.
  - **Phase 2 — frontends:** (only after both backend health checks pass) spawn `agent-playground` (port 5200) → `try_wait(100ms)` → write `pids/agent-playground.pid` → spawn `pty-server` (port 7681) → `try_wait(100ms)` → write `pids/pty-server.pid` → spawn `webhook-tunnel` (port 9090) → `try_wait(100ms)` → write `pids/webhook-tunnel.pid`.
  - **Final gate:** TCP-poll port 5200 up to 30s.
  - Open browser via `tauri-plugin-opener`.
- **Trust contract:** On `Ok`, all backend services (atlas, link) passed their health checks before any frontend process was spawned; all five processes passed the 100ms immediate-exit check; `FRIDAY_HOME` was set for all spawned processes so each app could load its configuration from `$FRIDAY_HOME/.env`; PID files have been written to `~/.friday/local/pids/` for all five processes; port 5200 became reachable within 30s; and the browser has been opened to `http://localhost:5200`. Writing PID files after the immediate-exit check means `check_running_processes()` correctly detects these processes on any subsequent installer open, regardless of whether they were started via `launch.rs` or the startup script. On `Err`, the message identifies whether the failure was a health check timeout (naming the service), an immediate-exit crash (naming the process and exit code), or port 5200 timeout. Uses `std::process::Command` directly (not `tauri-plugin-shell`) — no capability allowlist needed.

**`src/lib/installer.ts`** (TypeScript)
- **Interface:** Step orchestration — `advanceStep()`, `retryDownload()`, `canProceed()`, `detectInstallState()` → `{ mode: 'fresh' | 'update' | 'current', installedVersion?, availableVersion, studioRunning: boolean }`.
- **Hides:** `fetch_manifest` invocation (with 10s timeout error handling), `read_installed` call (None → fresh), semver comparison (`installed >= available` → current, `installed < available` → update), `check_running_processes()` call, step-sequence branching (fresh / update / current / running), Tauri command invocation sequence, `write_installed` call on successful extract, `delete_partial` call on checksum failure or missing file before retry, `check_download_complete` call to skip re-download on reopen, `mark_download_complete` call after successful `Done` event.
- **`verify_sha256` error handling:** Both `Ok(false)` (hash mismatch) and `Err` (IO error, e.g. file missing after OS temp cleanup) from `verify_sha256` are treated identically: call `delete_partial(platform)` to clear all checkpoint state, then show the re-download UI. The user-visible message distinguishes the two cases ("Checksum mismatch — re-downloading" vs "Download file not found — starting download again"), but both route to the same re-download step. `Err` is never surfaced as a fatal error screen from the verify step.
- **Semver comparison:** Implemented inline without an external library. Parses `major.minor.patch` from each version string (stripping any pre-release suffix like `-beta`), compares numerically. If installed version can't be parsed, treat as `fresh`. If available version can't be parsed, surface a manifest error.
- **Trust contract:** Frontend components call step methods and bind to `$state` store; they never call Tauri commands directly. The install/update mode is determined once at startup and does not change mid-flow. No download state is stored in `localStorage` — all checkpoint state lives on disk, managed by Rust commands.

**`src/lib/store.svelte.ts`**
- **Interface:** `$state` step enum + derived display values (progress %, speed string, ETA, error message).
- **Hides:** Channel message accumulation from `DownloadEvent` stream, bytes-to-human formatting, ETA calculation.
- **Trust contract:** Components read display-ready strings; no formatting logic in components.

### Manifest format

Hosted at a stable URL (e.g. `https://releases.hellofriday.ai/manifest.json`). Updated by CI on each release.

```json
{
  "version": "1.0.0",
  "platforms": {
    "macos-aarch64": {
      "url": "https://cdn.hellofriday.ai/releases/1.0.0/friday-studio-macos-arm64.tar.gz",
      "sha256": "<hash>",
      "size": 1200000000
    },
    "macos-x86_64": { "url": "...", "sha256": "...", "size": 0 },
    "windows-x86_64": { "url": "...", "sha256": "...", "size": 0 }
  }
}
```

Platform key is `{os}-{arch}` from Tauri's `os` plugin at runtime. Note: `platform()` returns `"macos"` (not `"darwin"`) and `arch()` returns `"aarch64"` (not `"arm64"`) — these differ from Node.js equivalents. The Tauri updater plugin uses a different internal `darwin-*` convention; our manifest uses the OS plugin's actual return values.

Fetched via `fetch_manifest` Rust command with a **10-second total timeout**. On timeout or network failure, the installer shows a clear error message with a Retry button — never hangs.

### Download / resume

- Partial file: `{tmp_dir}/friday-studio-{platform}.partial`
- Complete marker: `{tmp_dir}/friday-studio-{platform}.complete`
- On each attempt: read partial file size → send `Range: bytes={size}-` → server `206` resumes, server `200` truncates and restarts
- Retry: exponential backoff 1s / 2s / 4s / 8s / 16s, max 5 automatic attempts
- Manual retry: frontend "Try again" button re-invokes command (resumes from partial)
- Progress streamed via `Channel<DownloadEvent>` every 256KB; frontend derives ETA from `(total - downloaded) / bytes_per_sec`
- **Download checkpoint:** after receiving `Done` from `download_file`, `installer.ts` calls `mark_download_complete(platform)` before invoking `verify_sha256`. On reopening the installer, `installer.ts` calls `check_download_complete(platform)` — if `true`, skips re-download. All checkpoint state lives on disk in Rust-managed files; no `localStorage` is used for download state.
- **Checksum failure and missing-file handling:** both `verify_sha256` returning `Ok(false)` (hash mismatch) and `Err` (IO error — e.g. temp dir cleaned by OS after the `.complete` marker was written) are treated identically by `installer.ts`: call `delete_partial(platform)` to fully reset download state, then show the re-download UI. The user-visible message distinguishes the two cases ("Checksum mismatch — re-downloading" vs "Download file not found — starting download again"), but neither surfaces as a fatal error screen. This prevents the checkpoint from directing the user into a dead-end error state when the file disappears between sessions.

### Install paths

| Platform | Binary install path |
|---|---|
| macOS | `/Applications/Friday Studio.app/Contents/MacOS/` |
| Windows | `%LOCALAPPDATA%\Programs\Friday Studio\` |

macOS `.app` bundle in `/Applications` is automatically indexed by Spotlight — no extra configuration needed.

### Install state marker

`~/.friday/local/.installed` (macOS) / `%USERPROFILE%\.friday\local\.installed` (Windows)

Managed exclusively via the `installed_marker.rs` Tauri command (`write_installed` / `read_installed`). JSON on disk: `{ "version": "1.0.0", "installed_at": "2026-04-23T12:00:00Z" }`.

**Atomic write:** `write_installed` writes to `.installed.tmp` then renames to `.installed`. A crash between write and rename leaves a `.tmp` file that is ignored on next startup — the installer correctly treats the marker as absent and retries from scratch.

**Crash-safe read:** `read_installed` catches any JSON parse error (from a truncated mid-write), deletes the corrupted file, and returns `None`. The installer then treats the state as a fresh install without throwing.

Written by `installer.ts` immediately after successful extraction (before launch). The marker tracks what's on disk, not whether Studio is running — a launch failure is a runtime problem distinct from installation state.

Studio reads this file at startup to check for updates against the manifest and displays a banner when a newer version is available.

### FRIDAY_HOME and env file

All Studio configuration lives in a single directory: `~/.friday/local/` (macOS) / `%USERPROFILE%\.friday\local\` (Windows). The env var `FRIDAY_HOME` points to this directory and is set by both `launch.rs` (when spawning processes) and the startup script. Apps discover their configuration by reading `$FRIDAY_HOME/.env`.

`$FRIDAY_HOME/.env` contains two categories of vars, all written by `env_file.rs` during installation:

**User API keys** (written if provided and not already present):
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

**Platform-internal vars** (written on fresh install if not already present):
- `ATLAS_LOCAL_ONLY=true` — skips remote credential fetching in the `link` service
- `LINK_DEV_MODE=true` — enables Deno KV fallback in `link`
- `ATLAS_KEY=<fixed_jwt>` — local JWT: base64url(header) + "." + base64url(payload) + ".local". Accepted by `link` in `ATLAS_LOCAL_ONLY` mode. Generated in Rust at install time as a compile-time constant — no Node.js dependency.
- `ATLASD_URL=http://localhost:8080`
- `VITE_EXTERNAL_DAEMON_URL=http://localhost:8080`
- `VITE_EXTERNAL_TUNNEL_URL=http://localhost:9090`

Merge rules: existing values are never overwritten. Safe to call on reinstall or update — user customisations (including manually added vars) are always preserved.

The `ATLAS_KEY` JWT uses the literal string `"local"` as its signature component. The `link` service accepts this in `ATLAS_LOCAL_ONLY=true` mode. This is intentional: the single-user local install has no remote auth to validate against.

### Startup script location

`~/.friday/local/scripts/start-studio.sh` (macOS)
`%USERPROFILE%\.friday\local\scripts\start-studio.bat` (Windows)

Script sets `FRIDAY_HOME` then starts processes in two phases matching `launch.rs`:
1. **Backend phase:** start `atlas` (daemon) and `link` (auth service); poll their health endpoints before proceeding.
2. **Frontend phase:** start `agent-playground` (Vite dev server), `pty-server`, `webhook-tunnel` — only after backend health passes.

Apps read their configuration from `$FRIDAY_HOME/.env` at startup; the script does not inject platform-internal vars individually. PIDs written to `$FRIDAY_HOME/pids/`. Script polls `http://localhost:5200` (TCP connect, up to 30s) before opening browser. All paths in the script are quoted to handle the `Friday Studio` space in the install directory name.

### Code signing

**macOS** — Developer ID Application cert + notarization via App Store Connect API key:

| GH Actions Secret | Value / Source |
|---|---|
| `APPLE_CERTIFICATE` | base64(`Certificates.p12`) from 1Password item `ihyf5su33nzv4datgmpkch2st4` |
| `APPLE_CERTIFICATE_PASSWORD` | password field from same item |
| `KEYCHAIN_PASSWORD` | any strong random string — used for the ephemeral CI keychain only |
| `APPLE_API_KEY_CONTENT` | raw contents of `AuthKey_AB6R627888.p8` from 1Password (not base64) |
| `APPLE_API_KEY` | `AB6R627888` (the Key ID) |
| `APPLE_API_ISSUER` | `c8befdbb-b93d-43ba-974b-2e4f522b0502` (the Issuer UUID) |
| `APPLE_INSTALLER_CERTIFICATE` | base64(`installer-cert.p12`) from 1Password item `4ek6lq4yqxyrskuzwwzflqwtzq` |
| `APPLE_INSTALLER_CERTIFICATE_PASSWORD` | password field from same item |

`APPLE_SIGNING_IDENTITY` is **not a stored secret** — it is extracted dynamically from the CI keychain after the cert is imported (see CI steps below). This avoids having to keep the identity string in sync when the cert is renewed.

**CI .p8 handling:** `APPLE_API_KEY_CONTENT` (raw text) is written to `~/.private_keys/AuthKey_AB6R627888.p8` in the CI step. Tauri auto-discovers `.p8` files in `~/.private_keys/` when `APPLE_API_KEY_PATH` is not set — but we set it explicitly for clarity.

**`tauri.conf.json`** macOS bundle config requires `"hardenedRuntime": true` — mandatory for notarization. `"signingIdentity"` is left `null` in the file; the identity is injected at build time via the `APPLE_SIGNING_IDENTITY` env var (extracted from keychain).

Distribution format: signed + notarized `.dmg`.

**Windows** — self-signed certificate generated at build time. NSIS installer (`.exe`). SmartScreen warning acceptable for now; EV cert replaces self-signed without code changes.

### Windows installer config

NSIS config under `bundle.windows.nsis` in `tauri.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "currentUser",
        "startMenuFolder": "Friday",
        "languages": ["en-US"]
      },
      "webviewInstallMode": {
        "type": "embedBootstrapper"
      }
    }
  }
}
```

`installMode: "currentUser"` installs to `%LOCALAPPDATA%\Programs\Friday Studio` — no admin elevation required.

Tauri's default NSIS template automatically creates a Start Menu entry and desktop shortcut — `desktopShortcut`/`startMenuShortcut` are not valid NSIS config fields and do not exist in the Tauri schema. If custom shortcut behavior is ever needed, use an `NSIS_HOOK_POSTINSTALL` hook script via `installerHooks`.

**Critical:** `webviewInstallMode` must be `"embedBootstrapper"` (not the default `"downloadBootstrapper"`). Our Tauri installer is the first thing a user runs on a clean machine — if WebView2 isn't already installed, the installer window can't open at all. Embedding the bootstrapper adds ~1.8MB to the installer but guarantees it can run on any Windows 10+ machine without an internet connection specifically for WebView2 acquisition.

### Capabilities file

`src-tauri/capabilities/default.json` — all files in `src-tauri/capabilities/` are automatically enabled; no reference in `tauri.conf.json` needed. All file I/O and process spawning happen in Rust commands, so no `fs` or `shell` permissions are needed from the JS side. Required grants:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "installer-capability",
  "windows": ["main"],
  "permissions": [
    "os:default",
    "opener:allow-default-urls",
    { "identifier": "opener:allow-open-url", "allow": [{ "url": "http://localhost:5200" }] },
    "core:window:default",
    "core:event:default",
    "core:path:default"
  ]
}
```

Deny rules are not needed because no filesystem permissions are granted to JS at all.

### CI shape

Two parallel build jobs + one manifest-update job:

```
build-macos (matrix: aarch64 + x86_64):
  runs-on: macos-latest
  steps:
    1. rustup stable + add target (aarch64-apple-darwin or x86_64-apple-darwin)
    2. swatinem/rust-cache (workspaces: src-tauri → target)
    3. Import APPLE_CERTIFICATE into ephemeral keychain:
         echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
         security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
         security default-keychain -s build.keychain
         security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
         security set-keychain-settings -t 3600 -u build.keychain        ← prevents keychain locking mid-build
         security import certificate.p12 -k build.keychain -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
         security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain
    4. Extract signing identity dynamically:
         CERT_INFO=$(security find-identity -v -p codesigning build.keychain | grep "Developer ID Application")
         CERT_ID=$(echo "$CERT_INFO" | awk -F'"' '{print $2}')
         echo "APPLE_SIGNING_IDENTITY=$CERT_ID" >> $GITHUB_ENV
    5. Write .p8 to disk:
         mkdir -p ~/.private_keys
         echo "$APPLE_API_KEY_CONTENT" > ~/.private_keys/AuthKey_AB6R627888.p8
         echo "APPLE_API_KEY_PATH=$HOME/.private_keys/AuthKey_AB6R627888.p8" >> $GITHUB_ENV
    6. tauri build --target <arch>-apple-darwin --bundles dmg
       env: APPLE_SIGNING_IDENTITY (from step 4), APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD,
            APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
  produces: friday-studio.dmg (signed + notarized)

build-windows:
  runs-on: windows-latest
  steps:
    1. rustup stable (dtolnay/rust-toolchain sets stable-msvc automatically on Windows)
    2. swatinem/rust-cache
    3. Generate self-signed cert (PowerShell New-SelfSignedCertificate)
       Import-PfxCertificate → Cert:\CurrentUser\My
    4. tauri build --bundles nsis
       env: WINDOWS_CERTIFICATE, WINDOWS_CERTIFICATE_PASSWORD
  produces: friday-studio-setup.exe

update-manifest (runs after both):
  computes SHA256 for each artifact
  updates manifest.json with macos-aarch64, macos-x86_64, windows-x86_64 keys
  pushes to CDN
```

## Testing Decisions

A good test verifies observable behavior at module boundaries, not implementation steps. Tests should call the Rust command or TS function with real inputs and assert on outputs/side effects — not mock internals.

- **`env_file.rs`**: table-driven tests covering: fresh write — both user API keys and all platform-internal vars present (`ATLAS_LOCAL_ONLY`, `ATLAS_KEY`, `ATLASD_URL`, `VITE_EXTERNAL_DAEMON_URL`, `VITE_EXTERNAL_TUNNEL_URL`) after call; merge with existing user keys — pre-existing `ANTHROPIC_API_KEY` not overwritten; merge with pre-existing platform var — `ATLAS_LOCAL_ONLY` already set to custom value, not overwritten; Windows vs macOS path resolution; directory-creation side effect.
- **`verify.rs`**: known file + correct hash → `Ok(true)`; known file + wrong hash → `Ok(false)`; non-existent file → `Err`.
- **`delete_partial.rs`**: file exists → deleted, returns `Ok`; file absent → returns `Ok` (idempotent); directory absent → returns `Ok`; `.complete` marker also deleted when present; `.complete` absent → still returns `Ok` (idempotent for both files).
- **`download_checkpoint.rs`**: `mark_download_complete` then `check_download_complete` returns `true`; `check_download_complete` without mark returns `false`; `delete_partial` followed by `check_download_complete` returns `false` (partial and complete both cleared).
- **`fetch_manifest.rs`**: well-formed JSON → correct `Manifest` struct; malformed JSON → `Err`; timeout simulation → `Err` with timeout message within 10s.
- **`installed_marker.rs`**: write + read round-trip returns correct version; truncated/corrupt file → `read_installed` returns `None` and deletes file; concurrent write simulation (write to .tmp, crash before rename) → `.installed` absent, `.installed.tmp` present, next read returns `None`.
- **`installer.ts`**: unit tests for `detectInstallState()` branching — (no marker → fresh), (matching version → current), (installed < available → update), (installed > available → current, e.g. v1.1.0-beta vs v1.0.0 stable), each combined with `studioRunning: true/false`; step transition guards (can't advance from License without accepted=true, can't advance from ApiKeys without at least one key); checksum failure path (`Ok(false)`) calls `delete_partial` before retry (assert call order); IO error path (`Err`) from `verify_sha256` also calls `delete_partial` and shows re-download UI with "file not found" message — not a fatal error screen; semver comparison — pre-release suffix stripped, numeric comparison per component; `check_download_complete` called on startup, skips download when returns `true`; `delete_partial` clears checkpoint before retry.
- **`startup.rs`**: assert generated script contains all five binary names and the port-poll loop; assert macOS produces `.sh` and Windows produces `.bat`; assert paths with spaces are quoted; assert script sets `FRIDAY_HOME` to `~/.friday/local/` (macOS) or `%USERPROFILE%\.friday\local\` (Windows); assert script does NOT hardcode individual platform vars (`ATLAS_LOCAL_ONLY`, `ATLAS_KEY`, etc.) — those live in the env file.
- **`extract.rs`**: assert backup is created before extraction and deleted on success; assert backup is restored on simulated extraction failure; assert stale PID files with non-existent processes are cleaned up; assert Windows returns `Err` when process termination fails; assert pre-existing `.bak` directory is removed before rename (stale backup recovery — does not return `Err`).
- **`launch.rs`**: process that exits within 100ms → `Err` naming the process and exit code; atlasd health endpoint not reachable within 30s → `Err("atlasd did not become healthy within 30s")`; link health endpoint not reachable → `Err("link did not become healthy within 30s")`; agent-playground spawn not attempted until both backend health checks pass; all five processes stay alive, backends healthy, port 5200 opens → `Ok` with PID files written for all five processes and `FRIDAY_HOME` set in spawned process environment; `check_running_processes()` returns `true` immediately after successful `launch_studio()` (PID files exist and processes are live); port 5200 never opens within 30s → `Err` with timeout message.

Prior art: `packages/core/src/mcp-registry/config-validator.ts` tests for table-driven validation pattern.

End-to-end smoke test (manual, CI-gated on release): run installer on a clean macOS VM, verify `.dmg` mounts cleanly, installer completes, Studio opens in browser.

## Out of Scope

- Self-updating Studio binary — Studio shows a banner but does not download or apply updates itself; the user re-runs the installer.
- Silent / background updates — the installer always requires user confirmation.
- Uninstaller — not in this version.
- App Store distribution — Developer ID path only.
- Linux support — not in this iteration.
- EV cert for Windows — self-signed for now; cert swap is a CI secret change only.
- Multiple Studio instances / version management.
- Offline installation.

## Further Notes

- The `.p8` API key approach for notarization avoids Apple ID 2FA in CI entirely — no app-specific passwords needed.
- The Developer ID Installer cert (`installer-cert.p12`) is available if a `.pkg` distribution variant is ever needed; no code changes required, just an additional `tauri build` target.
- Manifest URL and CDN base URL should be environment-configurable at build time via Tauri's `TAURI_ENV_*` injection so staging and production can use different endpoints without separate code paths.
- Binary paths in the startup script are absolute at generation time, so the script is portable even if the user moves the installer app.
- Studio's update banner implementation: at startup, Studio fetches the manifest URL (same stable URL the installer uses), compares `manifest.version` against the version in `~/.friday/local/.installed`, and shows a dismissable banner with a link to the installer download page when `manifest > installed`. No download logic lives in Studio — the manifest fetch is the only coupling point between Studio and the installer infrastructure.
- The `check_running_processes()` command is also used by the Welcome screen to show the Studio-is-running state before any destructive action is taken. The same PID-checking logic inside `extract.rs` is exposed as a separate read-only query so the UI can present the right message without triggering termination.
- The `installed_marker.rs` atomic write pattern (`tmp` → `rename`) works correctly across all target platforms because both the tmp file and final file are in the same directory (`~/.friday/local/`), guaranteeing they are on the same filesystem. Cross-filesystem renames are not atomic on any OS.
- **Reference:** `docker/run-platform.sh` is the authoritative source for the platform startup sequence and environment variable requirements. `startup.rs` and `launch.rs` must stay in sync with any changes to that script.
- The `FRIDAY_HOME` convention (`~/.friday/local/`) is the single discovery mechanism for all Studio configuration. All installer-written state (`.env`, `.installed`, `pids/`, `scripts/`) lives under this directory. Apps that need platform config read `$FRIDAY_HOME/.env`; none rely on the installer injecting individual env vars at spawn time.
