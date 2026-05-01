import { Channel, invoke } from "@tauri-apps/api/core";
import { type ServiceStatus, store } from "./store.svelte.ts";

// ── Types matching Rust command signatures ────────────────────────────────────

interface Manifest {
  version: string;
  platforms: Record<string, PlatformEntry>;
}

interface PlatformEntry {
  url: string;
  sha256: string;
  size: number;
}

interface InstalledMarker {
  version: string;
  installed_at: string;
}

type DownloadEvent =
  | { type: "progress"; downloaded: number; total: number; bytes_per_sec: number }
  | { type: "retrying"; attempt: number; max_attempts: number; delay_secs: number; error: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ── Semver comparison (no external library) ───────────────────────────────────

function parseSemver(v: string): [number, number, number] {
  // Strip pre-release suffix (e.g., "1.2.3-beta" → "1.2.3")
  const clean = v.split("-")[0] ?? v;
  const parts = clean.split(".").map((p) => parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns negative / zero / positive like Array.sort comparator */
function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

// ── Detect install state ──────────────────────────────────────────────────────

// Manifest is fetched through download.fridayplatform.io (Cloudflare →
// atlas-traefik → friday-studio-artifact pod) — NOT direct GCS. The pod
// uses an authenticated GCS client, so it always reads the live object
// without GCS's anonymous-edge cache (which serves public objects with
// max-age=3600 by default and caused v0.0.7→v0.0.8 cutover to lag for
// users on 2026-04-27). Cloudflare in front of studio-artifact has
// max-age=60 set on this path so propagation is bounded.
const MANIFEST_URL = "https://download.fridayplatform.io/studio/manifest.json";

export async function detectInstallState(): Promise<void> {
  const [manifest, installed, running, hasProviderKey] = await Promise.all([
    invoke<Manifest>("fetch_manifest", { url: MANIFEST_URL }),
    invoke<InstalledMarker | null>("read_installed"),
    invoke<boolean>("check_running_processes"),
    // Probe ~/.friday/local/.env so the wizard can reroute users
    // through the API Keys step on update / reinstall flows when the
    // file is missing or doesn't carry an API key. Without this the
    // mode==="update" path skipped api-keys and the friday daemon
    // crashed at boot with "missing credentials" — the exact
    // fresh-install regression that bit us today.
    invoke<boolean>("env_file_has_provider_key").catch(() => false),
  ]);

  store.availableVersion = manifest.version;
  store.studioRunning = running;
  store.envHasProviderKey = hasProviderKey;

  if (installed === null) {
    store.installedVersion = null;
    store.mode = "fresh";
  } else {
    store.installedVersion = installed.version;
    const cmp = compareSemver(installed.version, manifest.version);
    store.mode = cmp >= 0 ? "current" : "update";
  }
}

// ── Step navigation ───────────────────────────────────────────────────────────

export function advanceStep(): void {
  const { step, mode } = store;

  switch (step) {
    case "welcome":
      if (mode === "current" && store.studioRunning) {
        void launchByOpening();
        store.step = "done";
      } else if (mode === "current" && !store.studioRunning) {
        store.step = "launch";
      } else if (mode === "update") {
        // Update path normally skips License + API Keys (the
        // existing install carries them on disk). But when the
        // .env doesn't have a provider key — observed on fresh-
        // system test 2026-04-28 where the marker existed but the
        // .env didn't — go through API Keys so the user has a
        // working key before launch. License is still skipped
        // (previously accepted, no need to re-confirm).
        store.step = store.envHasProviderKey ? "download" : "api-keys";
      } else {
        // Fresh install: full flow
        store.step = "license";
      }
      break;

    case "license":
      store.step = "api-keys";
      break;

    case "api-keys":
      store.step = "download";
      break;

    case "download":
      store.step = "extract";
      break;

    case "extract":
      store.step = "launch";
      break;

    case "launch":
      store.step = "done";
      break;

    case "done":
      break;
  }
}

async function launchByOpening(): Promise<void> {
  try {
    // Tauri 2 plugin-opener exports openUrl, not a default `open()`.
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(await resolvePlaygroundUrl());
  } catch {
    // ignore — browser might already be open
  }
}

/**
 * Returns the URL the wizard should open to land on the local
 * playground, honoring FRIDAY_PORT_PLAYGROUND from ~/.friday/local/.env.
 * Centralises the lookup so every "open studio" entry point lands on
 * the same URL — pre-fix, three call sites hardcoded :5200 and broke
 * any install with a port override.
 */
async function resolvePlaygroundUrl(): Promise<string> {
  try {
    return await invoke<string>("playground_url");
  } catch {
    // Tauri command unavailable (test env etc.) — fall back to the
    // installer's default port.
    return "http://localhost:15200";
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

let _downloadPlatform = "";

export async function startDownload(url: string, sha256: string, platform: string): Promise<void> {
  _downloadPlatform = platform;

  store.downloadedBytes = 0;
  store.totalBytes = 0;
  store.bytesPerSec = 0;
  store.downloadError = null;
  store.retryAttempt = 0;
  store.retryMax = 0;
  store.retryDelaySecs = 0;
  store.retryError = null;

  const dest = await getPartialPath(platform, url, sha256);
  store.downloadPath = dest;

  const channel = new Channel<DownloadEvent>();
  channel.onmessage = (event) => {
    if (event.type === "progress") {
      // Clear retry banner — the retry succeeded and download resumed.
      store.retryAttempt = 0;
      store.retryError = null;
      store.downloadedBytes = event.downloaded;
      store.totalBytes = event.total;
      store.bytesPerSec = event.bytes_per_sec;
    } else if (event.type === "retrying") {
      store.retryAttempt = event.attempt;
      store.retryMax = event.max_attempts;
      store.retryDelaySecs = event.delay_secs;
      store.retryError = event.error;
    } else if (event.type === "done") {
      store.downloadedBytes = store.totalBytes;
    } else if (event.type === "error") {
      store.downloadError = event.message;
    }
  };

  await invoke("download_file", { url, dest, onProgress: channel });
}

async function getPartialPath(platform: string, url: string, sha256: string): Promise<string> {
  const tmpDir = await getTmpDir();
  // Preserve the URL's archive extension on the local file. The Rust
  // extract_archive dispatches on the local file name, so saving a
  // .tar.zst URL as ".tar.gz" makes the gz reader fail with "failed to
  // iterate over archive". Three formats supported today: zip
  // (Windows), tar.zst (macOS/Linux post-bundle-size-reduction), and
  // tar.gz (legacy). New formats land here AND in extract.rs.
  let ext: string;
  if (url.endsWith(".zip")) ext = ".zip";
  else if (url.endsWith(".tar.zst")) ext = ".tar.zst";
  else if (url.endsWith(".tzst")) ext = ".tzst";
  else if (url.endsWith(".tgz")) ext = ".tgz";
  else ext = ".tar.gz";
  // Include the first 12 chars of the manifest sha so a partial download
  // from a previous version doesn't collide with a different version's path.
  // Without this, the resume-from-Range logic would splice old-version bytes
  // onto the new download and the SHA-256 verify step would reject the
  // result — exactly what happened the first time we shipped a v0.0.3
  // installer to a machine that had v0.0.2 partial state on disk.
  const tag = sha256.slice(0, 12);
  return `${tmpDir}/friday-studio-${platform}-${tag}${ext}`;
}

async function getTmpDir(): Promise<string> {
  // Tauri path API provides temp dir
  const { tempDir } = await import("@tauri-apps/api/path");
  return tempDir();
}

export async function retryDownload(): Promise<void> {
  // Re-fetch the manifest before retrying — never reuse the URL/sha
  // captured at the first startDownload(). If the user opened the
  // installer before a newer version was published, the captured URL
  // points at a now-dead version and every retry is doomed; refetching
  // gives us the live version each time. Caller's startDownload then
  // owns the partial-cleanup via delete_partial.
  await invoke("delete_partial", { platform: _downloadPlatform });
  const manifest = await fetchManifest();
  const entry = manifest.platforms[_downloadPlatform];
  if (!entry) {
    store.downloadError = `No download available for platform: ${_downloadPlatform}`;
    return;
  }
  await startDownload(entry.url, entry.sha256, _downloadPlatform);
}

// ── Extract ───────────────────────────────────────────────────────────────────

// Per-entry progress event emitted by extract_archive's Channel. The
// running count drives Extract.svelte's "Unpacking… N files" UI; no
// total because counting up-front would require a streaming pre-pass.
type ExtractEvent =
  | { type: "progress"; entries_done: number }
  | { type: "done" }
  | { type: "error"; message: string };

export async function runExtract(src: string, dest: string): Promise<void> {
  store.error = null;
  store.extractEntriesDone = 0;

  const channel = new Channel<ExtractEvent>();
  channel.onmessage = (event) => {
    if (event.type === "progress") {
      store.extractEntriesDone = event.entries_done;
    } else if (event.type === "error") {
      store.error = event.message;
    }
    // "done" is implicit when invoke resolves — no UI handler needed.
  };

  try {
    await invoke("extract_archive", { src, dest, onProgress: channel });
  } catch (err) {
    store.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

// ── Write API keys ────────────────────────────────────────────────────────────

export async function writeKeys(): Promise<void> {
  const trimmed = store.apiKey.trim() || null;
  // Only the selected provider's key is sent; the other three stay null so
  // write_env_file leaves any existing values for them in .env untouched.
  // write_env_file returns the absolute path it wrote to and verifies the
  // file landed on disk before returning Ok — see env_file.rs. If it
  // returned Err that propagates as a JS exception which the API Keys
  // step's handleContinue surfaces as saveError.
  const writtenPath = await invoke<string>("write_env_file", {
    anthropicKey: store.selectedProvider === "anthropic" ? trimmed : null,
    openaiKey: store.selectedProvider === "openai" ? trimmed : null,
    geminiKey: store.selectedProvider === "gemini" ? trimmed : null,
    groqKey: store.selectedProvider === "groq" ? trimmed : null,
  });
  // Belt-and-suspenders: if the user provided a key, double-check the
  // file actually contains a provider key. write_env_file already
  // read-back-verifies, but this catches the "user typed empty
  // string then clicked Continue" case (we treat empty as no-key
  // and don't write it; envHasProviderKey then returns false and
  // the wizard's update-path reroute kicks in next launch).
  store.envFilePath = writtenPath;
  store.envHasProviderKey = await invoke<boolean>("env_file_has_provider_key");
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function runLaunch(installDir: string): Promise<void> {
  store.error = null;
  try {
    await invoke("launch_studio", { installDir });
  } catch (err) {
    store.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

// ── Verify ────────────────────────────────────────────────────────────────────

export function verifyDownload(path: string, sha256: string): Promise<boolean> {
  return invoke<boolean>("verify_sha256", { path, expectedHash: sha256 });
}

// ── Manifest helper ───────────────────────────────────────────────────────────

export function fetchManifest(): Promise<Manifest> {
  return invoke<Manifest>("fetch_manifest", { url: MANIFEST_URL });
}

// ── Platform / install dir helpers ────────────────────────────────────────────

/**
 * Returns the platform key for this machine — must match a key the build
 * pipeline emits in `studio/manifest.json` (`macos-arm` / `macos-intel` /
 * `windows`). Computed in Rust via `cfg!(target_os/_arch)` so we get the
 * binary's actual compile target, not the JS-runtime guess.
 */
export function currentPlatform(): Promise<string> {
  return invoke<string>("current_platform");
}

/** Resolves the install root (`~/.friday/local`) without expansion logic in JS. */
export function installDir(): Promise<string> {
  return invoke<string>("install_dir");
}

// ── Wait-healthy SSE relay (Stack 2) ──────────────────────────────────────────

// Tagged events from the Rust wait_for_services command. Mirrors the
// HealthEvent enum in apps/studio-installer/src-tauri/src/commands/wait_health.rs;
// the `kind` discriminator + serde rename_all=kebab-case keeps the
// wire format ergonomic on the TS side.
export type HealthEvent =
  | { kind: "connecting" }
  | { kind: "connected" }
  | {
      kind: "snapshot";
      uptime_secs: number;
      services: ServiceStatus[];
      all_healthy: boolean;
      shutting_down: boolean;
    }
  | { kind: "soft-deadline" }
  | { kind: "timeout"; stuck: string[]; playground_healthy: boolean }
  | { kind: "unreachable"; reason: string }
  | { kind: "shutting-down" };

// `playground` is the user-facing surface that the browser actually
// loads; if it's healthy at hard-deadline we still let the user
// proceed via "Open anyway". Centralizing the name here avoids
// stringly-typed checks scattered across the UI.
const PLAYGROUND_SERVICE_NAME = "playground";

/**
 * Subscribe to the launcher's health stream and update the store as
 * events land. Returns when the wait-healthy step ends — for any
 * reason (all-healthy, timeout, unreachable, shutting-down). The
 * caller (Launch.svelte) reads `store.launchStage` to decide what
 * UI to render.
 *
 * Idempotent: calling `waitForServices` while a previous wait is
 * active will spawn a second SSE subscription on the Rust side; the
 * deadline state is mutex-guarded so the second wait simply replaces
 * the first. In practice the wizard only calls this once per
 * Launch step entry.
 */
export async function waitForServices(): Promise<void> {
  store.launchStage = "connecting";
  store.services = [];
  store.waitElapsedSecs = 0;
  store.waitDeadlineExtensions = 0;
  store.stuckServices = [];
  store.playgroundHealthyAtTimeout = false;
  store.launchUnreachableReason = null;

  const channel = new Channel<HealthEvent>();
  channel.onmessage = (event) => {
    switch (event.kind) {
      case "connecting":
        store.launchStage = "connecting";
        break;
      case "connected":
        store.launchStage = "waiting";
        break;
      case "snapshot":
        store.services = event.services;
        store.waitElapsedSecs = event.uptime_secs;
        if (event.shutting_down) {
          store.launchStage = "shutting-down";
        } else if (event.all_healthy) {
          store.launchStage = "ready";
        }
        // soft-deadline / timeout events drive the long-wait /
        // timeout transitions; snapshot doesn't override those.
        break;
      case "soft-deadline":
        if (store.launchStage === "waiting") {
          store.launchStage = "long-wait";
        }
        break;
      case "timeout":
        store.stuckServices = event.stuck;
        store.playgroundHealthyAtTimeout = event.playground_healthy;
        store.launchStage = "timeout";
        break;
      case "unreachable":
        store.launchUnreachableReason = event.reason;
        store.launchStage = "unreachable";
        break;
      case "shutting-down":
        store.launchStage = "shutting-down";
        break;
    }
  };

  await invoke("wait_for_services", { onEvent: channel });
}

/**
 * Push the wait-healthy hard deadline out by 60s. Capped at two
 * extensions (so the maximum total wait is 90 + 60 + 60 = 210s).
 * Returns the new deadline (seconds from wait start) or null if
 * the cap is reached. Updates `waitDeadlineExtensions` for the UI.
 */
export async function extendWaitDeadline(): Promise<number | null> {
  const newDeadline = await invoke<number | null>("extend_wait_deadline");
  if (newDeadline !== null) {
    store.waitDeadlineExtensions = store.waitDeadlineExtensions + 1;
    // Re-arm the long-wait UI: extension means we're back inside
    // the deadline, so suppress the timeout treatment.
    if (store.launchStage === "timeout") {
      store.launchStage = "long-wait";
    }
  }
  return newDeadline;
}

/**
 * Returns the playground row from the current snapshot, or undefined
 * if it hasn't been observed yet. Used by Launch.svelte to decide
 * whether to expose "Open anyway" alongside the timeout treatment.
 */
export function getPlaygroundService(): ServiceStatus | undefined {
  return store.services.find((s) => s.name === PLAYGROUND_SERVICE_NAME);
}

/**
 * Ask any previous-version launcher to shut down before this run's
 * Launch step spawns a fresh one. Returns true if a launcher was
 * actually stopped, false if nothing was running. Errors bubble up
 * so the UI can surface them — the most likely cause of an error is
 * the old launcher being unresponsive on the HTTP shutdown endpoint
 * (state we'd want to know about, not silently ignore).
 *
 * Without this, an in-place upgrade (existing launcher still alive,
 * binding port 5199) collides with the new launcher's bind attempt
 * and the user sees the "Port 5199 already in use" dialog with no
 * obvious recovery path other than `pkill` from a terminal.
 */
export function stopRunningLauncher(): Promise<boolean> {
  return invoke<boolean>("stop_running_launcher");
}

/**
 * Create /Applications/Friday Studio.app on darwin so Spotlight can
 * index the launcher and the user can re-open it from Finder /
 * Spotlight after they Quit. No-op (and quiet failure) on other
 * platforms — the Rust side is gated to darwin via a platform check
 * inside the command. Best-effort: a permission denied on
 * /Applications doesn't block the install (the launcher itself is
 * already running and reachable from the tray).
 */
export async function createAppBundleIfDarwin(installDir: string, version: string): Promise<void> {
  const platform = await currentPlatform();
  if (platform !== "macos-arm" && platform !== "macos-intel") return;
  try {
    await invoke("create_app_bundle", { launcherPath: `${installDir}/friday-launcher`, version });
  } catch (err) {
    // Non-fatal: log and continue. Most likely cause is /Applications
    // not being writable (managed Macs); user can still re-launch via
    // the tray icon while it's alive, just not from Spotlight after
    // Quit. We surface the error to the console for diagnostics but
    // don't block the install.
    console.warn("create_app_bundle failed (non-fatal):", err);
  }
}

/**
 * Open the playground in the user's browser and exit the wizard.
 * The launcher is detached from the wizard at spawn time, so exiting
 * the wizard does NOT kill the platform — the launcher keeps
 * supervising its services. Same exit logic for "Open anyway".
 *
 * We invoke a Rust-side `exit_installer` command rather than calling
 * `getCurrentWindow().close()` from JS — close() is permissioned and
 * doesn't always terminate the app on macOS (Tauri's default
 * close-requested handler can call preventDefault, leaving the
 * window up after openUrl resolves). `app.exit(0)` from Rust
 * bypasses every JS-level prevention path.
 */
export async function openPlaygroundAndExit(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(await resolvePlaygroundUrl());
  } catch {
    // ignore — browser might already be open or plugin unavailable
  }
  try {
    await invoke("exit_installer");
  } catch {
    // ignore — installer already exiting
  }
}

export type { Manifest, PlatformEntry };
