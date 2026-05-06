import type { MCPServerConfig } from "@atlas/agent-sdk";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  NoDefaultCredentialError,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { RetryError } from "@std/async/retry";

export type CachedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown> | null;
};

export type ProbePhase = "dns" | "connect" | "auth" | "tools";

export type PrewarmResult =
  | { ok: true; tools: CachedTool[] }
  | { ok: false; error: string; phase: ProbePhase };

type Entry = { configHash: string; tools: CachedTool[]; cachedAt: number };

const CACHE_TTL_MS = 60 * 60 * 1000;
const PREWARM_TIMEOUT_MS = 60_000;

// Time the GET handler waits on an in-flight prewarm before returning a
// retryable hint. Module-level so tests can shorten it without faking timers.
let raceCapMs = 5000;
export function getRaceCapMs(): number {
  return raceCapMs;
}
export function _setRaceCapForTest(ms: number): void {
  raceCapMs = ms;
}

const cache = new Map<string, Entry>();

// In-flight prewarms carry their configHash so that a mid-flight update
// (which races a v1 prewarm against a fresh v2 prewarm) doesn't dedupe v2
// onto the v1 promise — that would cache v1 tools under a v2 hash, leaving
// a subsequent GET to fall through to the foreground 5s probe instead of
// the prewarm fast-path.
type InFlightPrewarm = { configHash: string; promise: Promise<PrewarmResult> };
const inFlightPrewarm = new Map<string, InFlightPrewarm>();

function hashConfig(config: MCPServerConfig): string {
  // We rely on JSON.stringify dropping `undefined` values inside objects so
  // that `{env: undefined}` and `{}` hash identically — structurally
  // equivalent configs from different code paths must produce the same hash.
  // The replacer makes object key ordering deterministic.
  return JSON.stringify(config, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export function getCachedTools(serverId: string, config: MCPServerConfig): CachedTool[] | null {
  const entry = cache.get(serverId);
  if (!entry) return null;
  if (entry.configHash !== hashConfig(config)) return null;
  // Evict on read so expired entries don't accumulate over the daemon's
  // lifetime. The map otherwise grows monotonically with stale entries
  // (TTL is checked here but never followed by a delete).
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(serverId);
    return null;
  }
  return entry.tools;
}

export function putCachedTools(
  serverId: string,
  config: MCPServerConfig,
  tools: CachedTool[],
): void {
  cache.set(serverId, { configHash: hashConfig(config), tools, cachedAt: Date.now() });
}

export function invalidateCache(serverId: string): void {
  cache.delete(serverId);
}

export function getInFlightPrewarm(
  serverId: string,
  config: MCPServerConfig,
): Promise<PrewarmResult> | undefined {
  const inFlight = inFlightPrewarm.get(serverId);
  // Only dedupe onto the in-flight prewarm if its configHash matches the
  // requested config. A stale (e.g. v1) prewarm running while the caller
  // wants v2 must not be returned — the caller would block on it and then
  // see configHash mismatch on the cached result.
  if (!inFlight || inFlight.configHash !== hashConfig(config)) return undefined;
  return inFlight.promise;
}

// Callers must register prewarms synchronously after the preceding `await
// adapter.add` (or equivalent) — this helper does not poll for late
// registrations.
export function _resetCacheForTest(): void {
  cache.clear();
  inFlightPrewarm.clear();
  raceCapMs = 5000;
}

export async function _flushPrewarmsForTest(): Promise<void> {
  await Promise.allSettled(Array.from(inFlightPrewarm.values()).map((v) => v.promise));
}

/**
 * Probe an MCP server and extract its tool list. Throws on failure (including
 * credential-disconnected servers — those get surfaced as auth errors via
 * the classifier rather than caching an empty tool list).
 */
export async function probeAndExtract(
  serverId: string,
  config: MCPServerConfig,
  logger: Logger,
  timeoutMs: number,
): Promise<CachedTool[]> {
  const result = await createMCPTools({ [serverId]: config }, logger, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  // createMCPTools does not throw on missing/expired credentials — it routes
  // the server into `disconnected` with an empty tools map. For a single-
  // server probe, any disconnected entry means *this* probe failed.
  if (result.disconnected.length > 0) {
    await result.dispose();
    const entry = result.disconnected[0]!;
    // Throw a credential error so classifyProbeError routes this to phase:
    // "auth". `entry.message` is already a complete user-facing sentence
    // composed by buildDisconnectedEntry — preserve it verbatim instead of
    // re-templating through the constructor.
    const err = new LinkCredentialNotFoundError(entry.serverId);
    err.message = entry.message;
    throw err;
  }
  // createMCPTools also silently drops servers that fail to start (connect
  // error, MCPStartupError, list-tools timeout) — they're warn-logged but
  // don't appear in `disconnected`. For a single-server probe, an empty
  // `tools` map with no `disconnected` entry means *this* probe failed
  // silently. Throw so the classifier surfaces a real error rather than
  // caching `[]` for an hour.
  if (Object.keys(result.tools).length === 0) {
    await result.dispose();
    throw new Error(`MCP server "${serverId}" failed to start or expose tools`);
  }
  const tools: CachedTool[] = Object.entries(result.tools).map(([name, tool]) => {
    const t = tool as Record<string, unknown>;
    const schema = t.inputSchema as Record<string, unknown> | undefined;
    return {
      name,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: (schema?.jsonSchema ?? null) as Record<string, unknown> | null,
    };
  });
  await result.dispose();
  return tools;
}

/**
 * Background probe with a generous 60s timeout for cold `npx`/`uvx` installs.
 * Returns a structured result so the GET handler can surface the real error
 * (DNS, auth, MCPStartupError) when a user clicks before the prewarm
 * finishes — instead of a misleading "still starting up" hint.
 */
export function prewarmTools(
  serverId: string,
  config: MCPServerConfig,
  logger: Logger,
): Promise<PrewarmResult> {
  const newHash = hashConfig(config);
  const existing = inFlightPrewarm.get(serverId);
  // Only dedupe onto an existing prewarm when configs match. If a v1 prewarm
  // is still in flight when an update fires this with v2, start a fresh v2
  // prewarm — the v1 promise keeps running and will write v1 tools to the
  // cache (under v1 hash, harmless), but we need a v2 in-flight so a GET
  // racing the update finds something to await on.
  if (existing && existing.configHash === newHash) return existing.promise;
  const cached = getCachedTools(serverId, config);
  if (cached) {
    return Promise.resolve({ ok: true, tools: cached });
  }

  let entry: InFlightPrewarm | undefined;
  const promise = (async (): Promise<PrewarmResult> => {
    try {
      const tools = await probeAndExtract(serverId, config, logger, PREWARM_TIMEOUT_MS);
      putCachedTools(serverId, config, tools);
      logger.debug("MCP tools prewarmed", { serverId, toolCount: tools.length });
      return { ok: true, tools };
    } catch (error) {
      const classified = classifyProbeError(error);
      logger.debug("MCP tools prewarm failed", { serverId, ...classified });
      return { ok: false, error: classified.error, phase: classified.phase };
    } finally {
      // Only clear our own slot — a racing v2 prewarm may have replaced us
      // and we mustn't evict it.
      if (inFlightPrewarm.get(serverId) === entry) inFlightPrewarm.delete(serverId);
    }
  })();
  entry = { configHash: newHash, promise };

  inFlightPrewarm.set(serverId, entry);
  return promise;
}

/**
 * Classify an MCP tool probe error into a user-facing phase. Shared with the
 * foreground probe path in `mcp-registry.ts`.
 */
export function classifyProbeError(error: unknown): { error: string; phase: ProbePhase } {
  // Unwrap RetryError so we classify the underlying failure, not the retry wrapper.
  let inner = error;
  if (error instanceof RetryError && error.cause) {
    inner = error.cause;
  }

  // Match by `name` as well as `instanceof` — tests that drive the prewarm
  // through a deferred mock can produce instances whose prototype chain
  // disagrees with this module's class reference (vitest module-graph
  // quirk). The constructors all set `name` to a stable string.
  const credName =
    inner instanceof Error &&
    (inner.name === "LinkCredentialNotFoundError" ||
      inner.name === "LinkCredentialExpiredError" ||
      inner.name === "NoDefaultCredentialError");
  if (
    credName ||
    inner instanceof LinkCredentialNotFoundError ||
    inner instanceof LinkCredentialExpiredError ||
    inner instanceof NoDefaultCredentialError
  ) {
    return { error: error instanceof Error ? error.message : String(error), phase: "auth" };
  }

  if (
    inner instanceof Error &&
    inner.name === "MCPStartupError" &&
    "kind" in inner &&
    typeof inner.kind === "string"
  ) {
    const msg = inner.message + (inner.cause instanceof Error ? ` ${inner.cause.message}` : "");
    if (isDnsPattern(msg)) {
      return { error: inner.message, phase: "dns" };
    }
    return { error: inner.message, phase: "connect" };
  }

  if (inner instanceof Error) {
    const msg = inner.message + (inner.cause instanceof Error ? ` ${inner.cause.message}` : "");
    if (isDnsPattern(msg)) {
      return { error: inner.message, phase: "dns" };
    }
    if (isConnectPattern(msg)) {
      return { error: inner.message, phase: "connect" };
    }
    if (
      msg.toLowerCase().includes("tool") &&
      (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out"))
    ) {
      return { error: inner.message, phase: "tools" };
    }
    return { error: inner.message, phase: "connect" };
  }

  return { error: String(inner), phase: "connect" };
}

function isDnsPattern(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("eai_again") ||
    lower.includes("eai_nodata") ||
    lower.includes("name or service not known")
  );
}

function isConnectPattern(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("connection refused") ||
    lower.includes("connect etimedout") ||
    lower.includes("network is unreachable")
  );
}
