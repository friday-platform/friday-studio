/**
 * Version checking utility for Atlas CLI
 * Checks for newer versions from the Atlas update server with daily caching
 */

import { getAtlasBaseUrl } from "@atlas/core";
import { ensureDir, existsSync } from "@std/fs";
import { z } from "zod/v4";
import { ReleaseChannel } from "./release-channel.ts";
import { getVersionInfo } from "./version.ts";

// Complete version response schema - exhaustive as required
const versionItemSchema = z.object({
  channel: z.string(),
  version: z.string(),
  commit_hash: z.string(),
  date: z.string(),
  download_url: z.string(),
  checksum_url: z.string(),
});

const versionResponseSchema = z.object({
  channel: z.string(),
  latest: versionItemSchema,
  platforms: z.record(z.string(), versionItemSchema).optional(),
  last_updated: z.string(),
});

const versionCacheSchema = z.object({
  timestamp: z.number(),
  result: z.object({
    hasUpdate: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string().optional(),
    errorMessage: z.string().optional(),
    fromCache: z.boolean().optional(),
  }),
});

type VersionResponse = z.infer<typeof versionResponseSchema>;
type VersionCheckResult = z.infer<typeof versionCacheSchema>["result"];
type VersionCache = z.infer<typeof versionCacheSchema>;

/**
 * Parse version string to extract date for comparison
 * Handles multiple formats:
 * - Edge client: "edge-20250627-224715-f688387"
 * - Edge server: "20250627-224715-f688387"
 * - Nightly client: "nightly-20250627-224715-f688387" or "nightly-20250626-abc123"
 * - Nightly server: "20250626-179764e" (date-hash format)
 */
function parseVersionDate(version: string): Date | null {
  // Remove channel prefix if present (edge-, nightly-)
  const cleanVersion = version.replace(/^(edge|nightly)-/, "");

  // Try to match full datetime format first: YYYYMMDD-HHMMSS
  const fullMatch = cleanVersion.match(/^(\d{8})-(\d{6})/);
  if (fullMatch && fullMatch[1] && fullMatch[2]) {
    const dateStr = fullMatch[1];
    const timeStr = fullMatch[2];
    const year = parseInt(dateStr.substring(0, 4), 10);
    const month = parseInt(dateStr.substring(4, 6), 10) - 1; // Month is 0-indexed
    const day = parseInt(dateStr.substring(6, 8), 10);
    const hour = parseInt(timeStr.substring(0, 2), 10);
    const minute = parseInt(timeStr.substring(2, 4), 10);
    const second = parseInt(timeStr.substring(4, 6), 10);

    return new Date(year, month, day, hour, minute, second);
  }

  // Try to match date-only format: YYYYMMDD-hash
  const dateMatch = cleanVersion.match(/^(\d{8})-/);
  if (dateMatch && dateMatch[1]) {
    const dateStr = dateMatch[1];
    const year = parseInt(dateStr.substring(0, 4), 10);
    const month = parseInt(dateStr.substring(4, 6), 10) - 1; // Month is 0-indexed
    const day = parseInt(dateStr.substring(6, 8), 10);

    // Use start of day for date-only versions
    return new Date(year, month, day, 0, 0, 0);
  }

  return null;
}

/**
 * Check if current version is older than server version
 */
function isVersionOlder(currentVersion: string, serverVersion: string): boolean {
  const currentDate = parseVersionDate(currentVersion);
  const serverDate = parseVersionDate(serverVersion);

  if (!currentDate || !serverDate) {
    // If we can't parse dates, assume no update needed
    return false;
  }

  return currentDate < serverDate;
}

/**
 * Check if nightly version is older than 3 days
 */
function isNightlyOld(version: string): boolean {
  const versionDate = parseVersionDate(version);
  if (!versionDate) return false;

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  return versionDate < threeDaysAgo;
}

/**
 * Get cache directory for Atlas CLI
 */
function getCacheDir(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/tmp";
  return `${home}/.atlas/cache`;
}

/**
 * Get cache file path for version checking
 */
function getCacheFilePath(): string {
  return `${getCacheDir()}/version-check.json`;
}

/**
 * Check if cache is valid (less than 24 hours old)
 */
function isCacheValid(cache: VersionCache): boolean {
  const now = Date.now();
  const cacheAge = now - cache.timestamp;
  const oneDayMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  return cacheAge < oneDayMs;
}

/**
 * Load cached version check result
 */
async function loadCache(): Promise<VersionCache | null> {
  try {
    const cacheFile = getCacheFilePath();
    if (!existsSync(cacheFile)) {
      return null;
    }

    const data = await Deno.readTextFile(cacheFile);
    const cache = versionCacheSchema.safeParse(JSON.parse(data));

    if (!cache.success) {
      await Deno.remove(cacheFile).catch(() => {});
      return null;
    }

    if (isCacheValid(cache.data)) {
      return cache.data;
    }

    await Deno.remove(cacheFile).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

/**
 * Save version check result to cache
 */
async function saveCache(result: VersionCheckResult): Promise<void> {
  try {
    const cacheDir = getCacheDir();
    await ensureDir(cacheDir);

    const cache: VersionCache = { timestamp: Date.now(), result };

    const cacheFile = getCacheFilePath();
    await Deno.writeTextFile(cacheFile, JSON.stringify(cache));
  } catch {
    // Ignore cache write errors - don't let them affect CLI
  }
}

/**
 * Fetch version information from the Atlas update server
 */
async function fetchLatestVersion(channel: string): Promise<VersionResponse | null> {
  try {
    const response = await fetch(`${getAtlasBaseUrl()}/version/${channel}`, {
      method: "GET",
      headers: { "User-Agent": "Atlas-CLI" },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return null;
    }

    const parsed = versionResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Check for available updates with daily caching
 * @param forceCheck Skip cache and force fresh remote check
 */
export async function checkForUpdates(forceCheck: boolean = false): Promise<VersionCheckResult> {
  const versionInfo = getVersionInfo();
  const currentVersion = versionInfo.version;

  // Skip version checking for dev builds
  if (versionInfo.isDev) {
    return { hasUpdate: false, currentVersion };
  }

  // Check cache first - only check once per day (unless forced)
  if (!forceCheck) {
    const cached = await loadCache();
    if (cached && cached.result.currentVersion === currentVersion) {
      return { ...cached.result, fromCache: true };
    }
  }

  // Determine channel from version
  const channel = versionInfo.isNightly ? ReleaseChannel.Nightly : ReleaseChannel.Edge;

  try {
    const serverResponse = await fetchLatestVersion(channel);
    if (!serverResponse) {
      const result: VersionCheckResult = {
        hasUpdate: false,
        currentVersion,
        errorMessage: "Unable to check for updates",
      };
      // Cache negative results too to avoid repeated failures
      await saveCache(result);
      return result;
    }

    const latestVersion = serverResponse.latest.version;

    // For nightly builds, only show update message if current version is >3 days old
    if (versionInfo.isNightly) {
      if (!isNightlyOld(currentVersion)) {
        const result: VersionCheckResult = {
          hasUpdate: false,
          currentVersion,
          latestVersion: latestVersion, // Always include remote version
        };
        await saveCache(result);
        return result;
      }
    }

    // Compare versions
    const hasUpdate = isVersionOlder(currentVersion, latestVersion);

    const result: VersionCheckResult = {
      hasUpdate,
      currentVersion,
      latestVersion: latestVersion, // Always include remote version
    };

    // Cache the result
    await saveCache(result);
    return result;
  } catch (error) {
    const result: VersionCheckResult = {
      hasUpdate: false,
      currentVersion,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    };
    // Cache error results to avoid repeated attempts
    await saveCache(result);
    return result;
  }
}

/**
 * Display update message if newer version is available
 */
export async function checkAndDisplayUpdate(): Promise<void> {
  const result = await checkForUpdates();

  if (result.hasUpdate && result.latestVersion) {
    console.log(`A newer version is available: ${result.latestVersion}`);
  }

  // Silently ignore errors to avoid disrupting CLI usage
}

interface UpdateInfo {
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion: string;
  downloadUrl?: string;
}

/**
 * Check for updates and return download URL for update command
 */
export async function checkForUpdate(channel?: string): Promise<UpdateInfo> {
  const versionInfo = getVersionInfo();
  const currentVersion = versionInfo.version;

  // Determine channel
  if (!channel) {
    channel = versionInfo.isNightly
      ? ReleaseChannel.Nightly
      : versionInfo.isDev
        ? ReleaseChannel.Edge
        : ReleaseChannel.Edge;
  }

  try {
    const serverResponse = await fetchLatestVersion(channel);
    if (!serverResponse) {
      console.error(`No server response for channel: ${channel}`);
      return { updateAvailable: false, currentVersion };
    }

    const latestVersion = serverResponse.latest.version;

    // For dev builds, always show update available to release channels
    const hasUpdate = versionInfo.isDev ? true : isVersionOlder(currentVersion, latestVersion);

    // Build download URL for current platform
    const platform =
      Deno.build.os === "darwin" ? "darwin" : Deno.build.os === "linux" ? "linux" : "windows";
    const arch = Deno.build.arch === "x86_64" ? "amd64" : "arm64";
    const platformKey = `${platform}_${arch}`;

    const platformData = serverResponse.platforms?.[platformKey];
    let downloadUrl = platformData?.download_url || serverResponse.latest.download_url;

    // CRITICAL FIX: The version API is returning .sha256 URLs instead of binary URLs
    // Remove .sha256 extension if present to get the actual binary URL
    if (downloadUrl?.endsWith(".sha256")) {
      downloadUrl = downloadUrl.replace(/\.sha256$/, "");
    }

    // CRITICAL FIX 2: The version API returns .zip URLs for macOS but we need .tar.gz
    // Fix the extension based on platform
    if ((platform === "darwin" || platform === "linux") && downloadUrl) {
      // Replace .zip with .tar.gz for macOS/Linux
      downloadUrl = downloadUrl.replace(/\.zip$/, ".tar.gz");
    }

    // Make URL absolute
    if (downloadUrl && !downloadUrl.startsWith("http")) {
      downloadUrl = `${getAtlasBaseUrl()}${downloadUrl}`;
    }

    return { updateAvailable: hasUpdate, currentVersion, latestVersion, downloadUrl };
  } catch {
    return { updateAvailable: false, currentVersion };
  }
}
