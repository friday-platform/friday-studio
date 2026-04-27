import { Channel, invoke } from "@tauri-apps/api/core";
import { store } from "./store.svelte.ts";

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

const MANIFEST_URL =
  "https://storage.googleapis.com/friday-production-studio-artifact/studio/manifest.json";

export async function detectInstallState(): Promise<void> {
  const [manifest, installed, running] = await Promise.all([
    invoke<Manifest>("fetch_manifest", { url: MANIFEST_URL }),
    invoke<InstalledMarker | null>("read_installed"),
    invoke<boolean>("check_running_processes"),
  ]);

  store.availableVersion = manifest.version;
  store.studioRunning = running;

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
        // Update: skip License + API Keys — existing install already has both
        store.step = "download";
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
    await openUrl("http://localhost:5200");
  } catch {
    // ignore — browser might already be open
  }
}

// ── Proceed guard ─────────────────────────────────────────────────────────────

export function canProceed(): boolean {
  switch (store.step) {
    case "welcome":
      return true;
    case "license":
      return store.licenseAccepted;
    case "api-keys":
      return store.anthropicKey.trim().length > 0 || store.openaiKey.trim().length > 0;
    case "download":
      return store.downloadError === null && store.progressPercent === 100;
    case "extract":
      return store.error === null;
    case "launch":
      return store.error === null;
    case "done":
      return false;
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

let _downloadUrl = "";
let _downloadSha256 = "";
let _downloadPlatform = "";

export async function startDownload(url: string, sha256: string, platform: string): Promise<void> {
  _downloadUrl = url;
  _downloadSha256 = sha256;
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
  await invoke("delete_partial", { platform: _downloadPlatform });
  await startDownload(_downloadUrl, _downloadSha256, _downloadPlatform);
}

// ── Extract ───────────────────────────────────────────────────────────────────

export async function runExtract(src: string, dest: string): Promise<void> {
  store.error = null;
  try {
    await invoke("extract_archive", { src, dest });
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
  await invoke("write_env_file", {
    anthropicKey: store.selectedProvider === "anthropic" ? trimmed : null,
    openaiKey: store.selectedProvider === "openai" ? trimmed : null,
    geminiKey: store.selectedProvider === "gemini" ? trimmed : null,
    groqKey: store.selectedProvider === "groq" ? trimmed : null,
  });
}

// ── Startup script ────────────────────────────────────────────────────────────

export function writeStartupScript(installDir: string): Promise<string> {
  return invoke<string>("create_startup_script", { installDir });
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

export type { Manifest, PlatformEntry };
