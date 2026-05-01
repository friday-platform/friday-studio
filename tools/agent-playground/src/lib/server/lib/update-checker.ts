import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger/console";
import { getFridayHome } from "@atlas/utils/paths.server";
import { z } from "zod";

const MANIFEST_URL_DEFAULT = "https://download.fridayplatform.io/studio/manifest.json";
const FETCH_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_MIN_MS = 30_000;
const STARTUP_MAX_MS = 5 * 60 * 1000;
const STEADY_JITTER_MAX_MS = 6 * 60 * 60 * 1000;

const ManifestSchema = z.object({
  version: z.string().min(1),
});

const CacheFileSchema = z.object({
  latestVersion: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

export type UpdateStatus = {
  current: string;
  latest: string | null;
  outOfDate: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  isDev: boolean;
};

/**
 * Strips pre-release suffix (e.g. "1.2.3-beta" → [1, 2, 3]). Documented behavior:
 * pre-release versions in the manifest are silently treated as the base version.
 * Lifted from apps/studio-installer/src/lib/installer.ts.
 */
function parseSemver(v: string): [number, number, number] {
  const clean = v.split("-")[0] ?? v;
  const parts = clean.split(".").map((p) => parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

function readStudioVersion(): { version: string; isDev: boolean } {
  const override = process.env.FRIDAY_UPDATE_VERSION_OVERRIDE;
  if (override && override.trim().length > 0) {
    return { version: override.trim(), isDev: false };
  }
  // FRIDAY_UPDATE_SIDECAR_DIR is an internal test-only override —
  // production reads the sidecar from dirname(Deno.execPath()).
  const sidecarDir = process.env.FRIDAY_UPDATE_SIDECAR_DIR ?? dirname(Deno.execPath());
  try {
    const sidecarPath = join(sidecarDir, ".studio-version");
    const version = readFileSync(sidecarPath, "utf8").trim();
    if (version) return { version, isDev: false };
  } catch {
    // Missing sidecar → dev mode.
  }
  return { version: "0.0.0-dev", isDev: true };
}

function emptyCache(): CacheFile {
  return { latestVersion: null, lastCheckedAt: null, lastSuccessAt: null, lastError: null };
}

function jitterRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

class UpdateChecker {
  #version: string;
  #isDev: boolean;
  #manifestUrl: string;
  #cacheFile: string;
  #cacheDir: string;
  #cache: CacheFile = emptyCache();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inflight: Promise<UpdateStatus> | null = null;
  #started = false;

  constructor() {
    const resolved = readStudioVersion();
    this.#version = resolved.version;
    this.#isDev = resolved.isDev;
    this.#manifestUrl = process.env.FRIDAY_UPDATE_MANIFEST_URL ?? MANIFEST_URL_DEFAULT;
    this.#cacheDir = getFridayHome();
    this.#cacheFile = join(this.#cacheDir, "update-check.json");
    this.#loadCache();
  }

  /**
   * Idempotent — schedules the first check exactly once. In dev mode this is a no-op:
   * we never fetch the manifest for a dev build.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#isDev) {
      logger.warn("Studio update check skipped — dev build (no .studio-version sidecar)");
      return;
    }
    this.#scheduleStartup();
  }

  getUpdateStatus(): UpdateStatus {
    const latest = this.#cache.latestVersion;
    const outOfDate =
      !this.#isDev && latest !== null && compareSemver(this.#version, latest) < 0;
    return {
      current: this.#version,
      latest,
      outOfDate,
      lastCheckedAt: this.#cache.lastCheckedAt,
      lastSuccessAt: this.#cache.lastSuccessAt,
      error: this.#cache.lastError,
      isDev: this.#isDev,
    };
  }

  /**
   * Runs an immediate check, sharing one in-flight promise across concurrent callers
   * so the route handler and the scheduler can never race two writes to the cache file.
   */
  forceCheck(): Promise<UpdateStatus> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#doCheck().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  #loadCache(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#cacheFile, "utf8");
    } catch {
      // Missing file is the expected first-run state, not a warning.
      this.#cache = emptyCache();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      this.#cache = CacheFileSchema.parse(parsed);
    } catch (err) {
      logger.warn("update-check cache file is malformed — treating as empty", {
        path: this.#cacheFile,
        error: err instanceof Error ? err.message : String(err),
      });
      this.#cache = emptyCache();
    }
  }

  async #saveCache(): Promise<void> {
    // mkdir is required: on a fresh machine the parent dir doesn't exist
    // and rename() throws ENOENT. This is the documented fix.
    await mkdir(this.#cacheDir, { recursive: true });
    const tmp = `${this.#cacheFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#cache, null, 2), "utf8");
    await rename(tmp, this.#cacheFile);
  }

  /**
   * Shared by manual + scheduled paths: cancel timer → fetch → update cache → re-arm.
   * Never throws — fetch errors are recorded as `lastError` on the cache.
   */
  async #doCheck(): Promise<UpdateStatus> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const checkedAt = new Date().toISOString();
    try {
      const version = await this.#fetchManifestVersion();
      this.#cache = {
        latestVersion: version,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        lastError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Studio update check failed", { error: message });
      // Leave latestVersion + lastSuccessAt untouched — stale-but-good cache wins.
      this.#cache = {
        latestVersion: this.#cache.latestVersion,
        lastCheckedAt: checkedAt,
        lastSuccessAt: this.#cache.lastSuccessAt,
        lastError: message,
      };
    }
    try {
      await this.#saveCache();
    } catch (err) {
      // Cache write failure is non-fatal — in-memory cache is still serve-able.
      logger.warn("update-check cache write failed", {
        path: this.#cacheFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.#scheduleSteady();
    return this.getUpdateStatus();
  }

  async #fetchManifestVersion(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.#manifestUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`manifest fetch returned HTTP ${res.status}`);
      }
      const body: unknown = await res.json();
      const parsed = ManifestSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`manifest schema validation failed: ${parsed.error.message}`);
      }
      return parsed.data.version;
    } finally {
      clearTimeout(timeout);
    }
  }

  #scheduleStartup(): void {
    const force = process.env.FRIDAY_UPDATE_FORCE;
    const lastCheckedAt =
      force && force.length > 0 ? null : this.#cache.lastCheckedAt;
    let delayMs: number;
    if (lastCheckedAt === null) {
      delayMs = jitterRange(STARTUP_MIN_MS, STARTUP_MAX_MS);
    } else {
      const since = Date.now() - new Date(lastCheckedAt).getTime();
      if (since >= DAY_MS || since < 0) {
        delayMs = jitterRange(STARTUP_MIN_MS, STARTUP_MAX_MS);
      } else {
        delayMs = DAY_MS - since + Math.random() * STEADY_JITTER_MAX_MS;
      }
    }
    this.#armTimer(delayMs);
  }

  #scheduleSteady(): void {
    const delayMs = DAY_MS + Math.random() * STEADY_JITTER_MAX_MS;
    this.#armTimer(delayMs);
  }

  #armTimer(delayMs: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.forceCheck();
    }, delayMs);
    logger.info("Studio update check scheduled", { delayMs: Math.round(delayMs) });
  }
}

declare global {
  // HMR-safe singleton: Vite re-imports modules on save, which would otherwise
  // leak setTimeout timers. Stashing on globalThis survives module reloads.
  // eslint-disable-next-line no-var
  var __fridayUpdateChecker: UpdateChecker | undefined;
}

export const updateChecker = (globalThis.__fridayUpdateChecker ??= new UpdateChecker());
updateChecker.start();
