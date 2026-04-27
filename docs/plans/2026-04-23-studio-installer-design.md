# Friday Studio Installer — Design

## Problem Statement

Installing Friday Studio requires manually downloading a 1GB+ binary, unpacking it to the right location, configuring API keys, writing startup scripts for five separate processes, and knowing how to launch them. There is no guided experience, no progress feedback for the large download, and no safety net for partial downloads or missing configuration. First-time users have no clear path from "I have a download link" to "Studio is running in my browser."

## Solution

A Tauri 2.x desktop installer app (`apps/studio-installer`) that guides users through a linear step flow, handles the large binary download with resume/retry support, collects at least one API key before downloading, verifies the checksum, unpacks to the OS-correct location, writes a startup script, and opens the browser to Studio once everything is running. Ships as a signed `.dmg` on macOS and a self-signed `.exe` on Windows, built in CI via GitHub Actions.

The installer also doubles as the **updater**: re-running it detects an existing installation, compares the installed version against the manifest, stops any running Studio processes, overwrites the binaries, and relaunches. Studio itself shows a passive update-available banner (linking back to the installer download page) but does not self-update.

Frontend: plain Svelte 5 + TypeScript (not SvelteKit — the installer is a linear flow with no routing, so the SvelteKit overhead adds nothing).

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

## Implementation Decisions

### Project location

`apps/studio-installer` in the Atlas monorepo. Intended to move to a dedicated repository at a later date; the internal structure is self-contained so extraction is straightforward.

### Step flow

**Fresh install:**
```
Welcome → License (scroll-to-accept) → API Keys → Download + Verify → Extract → Launch
```

**Update (existing install detected):**
```
Welcome (shows "v1.0.0 → v1.2.0 available") → Stop Processes → Download + Verify → Extract → Launch
```

License and API key steps are skipped on update: license was already accepted (marker file present) and existing keys are preserved by `env_file.rs`. If no update is available, the installer shows "You're already on the latest version."

On startup the installer checks `~/.friday/local/.installed` (a JSON file: `{ "version": "1.0.0", "installed_at": "..." }`), compares against the manifest version, and branches to the appropriate flow. Collecting API keys before the download means first-time users discover missing credentials in ~10 seconds instead of after a multi-minute download.

### Module Boundaries

**`src-tauri/src/commands/download.rs`**
- **Interface:** `download_file(url, dest, on_progress: Channel<DownloadEvent>)` — Tauri command. Uses a typed Channel (not loose events) for ordered, high-throughput progress streaming. `DownloadEvent` is a tagged union: `Progress { downloaded, total, bytes_per_sec }` | `Done` | `Error { message }`.
- **Hides:** HTTP Range resume logic, chunk streaming, retry backoff schedule, partial file management, reqwest client lifecycle.
- **Trust contract:** Caller provides a channel callback; receives ordered progress messages and a terminal `Done` or `Error`. Retry/resume is fully automatic up to 5 attempts; on exhaustion sends `Error` through the channel.

**`src-tauri/src/commands/verify.rs`**
- **Interface:** `verify_sha256(path, expected_hash)` → `Result<bool, String>`
- **Hides:** Streaming file read, SHA256 accumulation (never loads 1GB into memory).
- **Trust contract:** Returns `true` only on exact match. On mismatch or IO error returns `Err`.

**`src-tauri/src/commands/extract.rs`**
- **Interface:** `extract_archive(src, dest)` → `Result<(), String>`
- **Hides:** Format detection (`.tar.gz` on macOS, `.zip` on Windows), OS-appropriate unpack path resolution. On update: reads `~/.friday/local/pids/` to find running Studio processes and sends SIGTERM (macOS) / `TerminateProcess` (Windows) before extracting; waits up to 10s for clean exit, then SIGKILL. On Windows, running executables cannot be overwritten — process termination is mandatory, not optional.
- **Trust contract:** On success, binaries are at the canonical install path for the current platform and no Studio processes are running. Fresh install and update use the same interface; caller does not need to know which case applies.

**`src-tauri/src/commands/env_file.rs`**
- **Interface:** `write_env_file(anthropic_key?, openai_key?)` → `Result<(), String>`
- **Hides:** Path resolution (`~/.friday/local/.env` / `%USERPROFILE%\.friday\local\.env`), existing-file parse, merge logic (never overwrites a present key), directory creation.
- **Trust contract:** After call, `.env` contains at least the provided keys. Pre-existing keys are untouched.

**`src-tauri/src/commands/startup.rs`**
- **Interface:** `create_startup_script(install_dir)` → `Result<String, String>` (returns script path)
- **Hides:** Platform-appropriate script format (`.sh` with `nohup` on macOS/Linux, `.bat` with `start /B` on Windows), PID file location (`~/.friday/local/pids/`), binary path construction from install dir.
- **Trust contract:** Script at returned path, when executed, starts all five Studio processes and is idempotent.

**`src-tauri/src/commands/launch.rs`**
- **Interface:** `launch_studio(install_dir: String)` → `Result<(), String>`
- **Hides:** Direct `std::process::Command` spawning of all five processes (link → atlas → pty-server → webhook-tunnel → agent-playground) from `install_dir`, detached from the installer process. TCP poll loop on port 5200 (up to 30s). `tauri-plugin-opener` call to open browser.
- **Trust contract:** On `Ok`, all five processes are running and the browser has been opened to `http://localhost:5200`. On `Err`, at least one process failed to start. Note: uses `std::process::Command` directly (not `tauri-plugin-shell`) — no capability allowlist needed since this runs in Rust, not JS.

**`src/lib/installer.ts`** (TypeScript)
- **Interface:** Step orchestration — `advanceStep()`, `retryDownload()`, `canProceed()`, `detectInstallState()` → `{ mode: 'fresh' | 'update' | 'current', installedVersion?, availableVersion }`.
- **Hides:** `~/.friday/local/.installed` read via Tauri command, manifest fetch + platform detection, version comparison, step-sequence branching (fresh vs update), Tauri command invocation sequence, `.installed` write on completion.
- **Trust contract:** Frontend components call step methods and bind to `$state` store; they never call Tauri commands directly. The install/update mode is determined once at startup and does not change mid-flow.

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

### Download / resume

- Partial file: `{tmp_dir}/friday-studio-{platform}.partial`
- On each attempt: read partial file size → send `Range: bytes={size}-` → server `206` resumes, server `200` truncates and restarts
- Retry: exponential backoff 1s / 2s / 4s / 8s / 16s, max 5 automatic attempts
- Manual retry: frontend "Try again" button re-invokes command (resumes from partial)
- Progress streamed via `Channel<DownloadEvent>` every 256KB; frontend derives ETA from `(total - downloaded) / bytes_per_sec`
- Checkpoint: `localStorage` records `download:complete` so reopening the installer skips re-download if partial is still present and valid

### Install paths

| Platform | Binary install path |
|---|---|
| macOS | `/Applications/Friday Studio.app/Contents/MacOS/` |
| Windows | `%LOCALAPPDATA%\Programs\Friday Studio\` |

macOS `.app` bundle in `/Applications` is automatically indexed by Spotlight — no extra configuration needed.

### Install state marker

`~/.friday/local/.installed` (macOS) / `%USERPROFILE%\.friday\local\.installed` (Windows)

Written by the installer on successful completion. JSON: `{ "version": "1.0.0", "installed_at": "2026-04-23T12:00:00Z" }`. Read on startup to detect mode (fresh / update / current). Absence → fresh install. Version match with manifest → already current. Version mismatch → update flow.

Studio reads this file at startup to check for updates against the manifest and displays a banner when a newer version is available.

### Startup script location

`~/.friday/local/scripts/start-studio.sh` (macOS)
`%USERPROFILE%\.friday\local\scripts\start-studio.bat` (Windows)

Script starts processes in order: `link` → `atlas` → `pty-server` → `webhook-tunnel` → `agent-playground`. PIDs written to `~/.friday/local/pids/`. Script polls `http://localhost:5200` (TCP connect, up to 30s) before opening browser.

### API key env file

Path: `~/.friday/local/.env` (macOS) / `%USERPROFILE%\.friday\local\.env` (Windows)

Merge rules:
- Read and parse existing file if present
- `ANTHROPIC_API_KEY`: write only if not already set and non-empty
- `OPENAI_API_KEY`: write only if not already set and non-empty
- All other existing lines preserved verbatim
- Directory created if absent

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

- **`env_file.rs`**: table-driven tests covering fresh write, merge with existing keys, preservation of pre-existing keys, Windows vs macOS path resolution, and directory-creation side effect.
- **`verify.rs`**: known file + correct hash → `true`; known file + wrong hash → `false`; non-existent file → `Err`.
- **`installer.ts`**: unit tests for manifest platform-key resolution (macos-aarch64, macos-x86_64, windows-x86_64 — using OS plugin values, not Node.js equivalents), step transition guards (can't advance from License without accepted=true, can't advance from ApiKeys without at least one key), `detectInstallState()` branching (no marker → fresh, matching version → current, older version → update).
- **`startup.rs`**: assert generated script content contains all five binary names and the port-poll loop; assert macOS produces `.sh` and Windows produces `.bat`.
- **`extract.rs`**: assert that stale PID files with non-existent processes are handled gracefully (process already gone); assert Windows path returns `Err` when process termination fails (can't overwrite running exe).

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
- Studio's update banner implementation: at startup, Studio fetches the manifest URL (same stable URL the installer uses), compares `manifest.version` against the version embedded in its own binary (written into `~/.friday/local/.installed` at install time), and shows a dismissable banner with a link to the installer download page. No download logic lives in Studio — the manifest fetch is the only coupling point between Studio and the installer infrastructure.
