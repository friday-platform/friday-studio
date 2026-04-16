/**
 * HTTP client for the skills.sh search + download API.
 *
 * Provides in-memory TTL cache, Zod-validated responses, and
 * official-skill priority sorting.
 *
 * @module
 */

import { createLogger } from "@atlas/logger";
import { z } from "zod";

const logger = createLogger({ name: "skills-sh-client" });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

export const SkillsShSkillEntrySchema = z.object({
  id: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number().int().nonnegative(),
  source: z.string(),
});

export type SkillsShSkillEntry = z.infer<typeof SkillsShSkillEntrySchema>;

export const SkillsShSearchResultSchema = z.object({
  query: z.string(),
  searchType: z.string(),
  skills: z.array(SkillsShSkillEntrySchema),
  count: z.number().int().nonnegative(),
  duration_ms: z.number(),
});

export type SkillsShSearchResult = z.infer<typeof SkillsShSearchResultSchema>;

export const SkillsShFileSchema = z.object({ path: z.string(), contents: z.string() });

export type SkillsShFile = z.infer<typeof SkillsShFileSchema>;

export const SkillsShDownloadResultSchema = z.object({
  files: z.array(SkillsShFileSchema),
  hash: z.string().length(64),
});

export type SkillsShDownloadResult = z.infer<typeof SkillsShDownloadResultSchema>;

// ─── Priority sorting ────────────────────────────────────────────────────────

/**
 * Known-official orgs whose skills are prioritised in search results.
 */
const OFFICIAL_ORGS = new Set([
  "anthropics",
  "anthropic",
  "vercel",
  "microsoft",
  "google",
  "openai",
  "github",
  "supabase",
  "official",
]);

/**
 * Sort entries so that skills from official orgs float to the top,
 * with higher install counts as a tiebreaker.
 */
export function sortByOfficialPriority(entries: SkillsShSkillEntry[]): SkillsShSkillEntry[] {
  return [...entries].sort((a, b) => {
    const aOfficial = isOfficialSource(a.source) ? 1 : 0;
    const bOfficial = isOfficialSource(b.source) ? 1 : 0;
    if (aOfficial !== bOfficial) return bOfficial - aOfficial;
    return b.installs - a.installs;
  });
}

function isOfficialSource(source: string): boolean {
  const normalised = source.toLowerCase().split("/")[0] ?? "";
  return OFFICIAL_ORGS.has(normalised);
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Client ──────────────────────────────────────────────────────────────────

export interface SkillsShClientOptions {
  baseUrl?: string;
  ttlMs?: number;
  /** Optional override for testing — defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

export class SkillsShClient {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly searchCache = new Map<string, CacheEntry<SkillsShSearchResult>>();
  private readonly downloadCache = new Map<string, CacheEntry<SkillsShDownloadResult>>();

  constructor(options: SkillsShClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://skills.sh").replace(/\/$/, "");
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Search for skills matching the given query.
   * Results are cached in-memory with lazy TTL eviction.
   */
  async search(query: string, limit = 10): Promise<SkillsShSearchResult> {
    const cacheKey = `${query}::${String(limit)}`;
    const cached = this.getFromCache(this.searchCache, cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`;
    logger.debug("skills.sh search", { url });

    const response = await this.fetchFn(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`skills.sh search failed: ${String(response.status)} ${response.statusText}`);
    }

    const json: unknown = await response.json();
    const parsed = SkillsShSearchResultSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("skills.sh returned malformed search result", { error: parsed.error.message });
      throw new Error(`skills.sh returned invalid response: ${parsed.error.message}`);
    }

    // Sort with official priority before caching
    const result: SkillsShSearchResult = {
      ...parsed.data,
      skills: sortByOfficialPriority(parsed.data.skills),
    };
    this.putInCache(this.searchCache, cacheKey, result);
    return result;
  }

  /**
   * Download a skill by owner/repo/slug path.
   * Returns the file contents and content hash.
   */
  async download(owner: string, repo: string, slug: string): Promise<SkillsShDownloadResult> {
    const cacheKey = `${owner}/${repo}/${slug}`;
    const cached = this.getFromCache(this.downloadCache, cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`;
    logger.debug("skills.sh download", { url });

    const response = await this.fetchFn(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(
        `skills.sh download failed: ${String(response.status)} ${response.statusText}`,
      );
    }

    const json: unknown = await response.json();
    const parsed = SkillsShDownloadResultSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("skills.sh returned malformed download result", { error: parsed.error.message });
      throw new Error(`skills.sh returned invalid download response: ${parsed.error.message}`);
    }

    this.putInCache(this.downloadCache, cacheKey, parsed.data);
    return parsed.data;
  }

  /** Clear all cached entries. */
  clearCache(): void {
    this.searchCache.clear();
    this.downloadCache.clear();
  }

  // ─── Cache helpers ─────────────────────────────────────────────────────────

  private getFromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private putInCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
    cache.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }
}
