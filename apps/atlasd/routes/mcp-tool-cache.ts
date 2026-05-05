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

const cache = new Map<string, Entry>();
const inFlightPrewarm = new Map<string, Promise<PrewarmResult>>();

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
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
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

export function getInFlightPrewarm(serverId: string): Promise<PrewarmResult> | undefined {
  return inFlightPrewarm.get(serverId);
}

// Callers must register prewarms synchronously after the preceding `await
// adapter.add` (or equivalent) — this helper does not poll for late
// registrations.
export function _resetCacheForTest(): void {
  cache.clear();
  inFlightPrewarm.clear();
}

export async function _flushPrewarmsForTest(): Promise<void> {
  await Promise.allSettled(inFlightPrewarm.values());
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
    throw new LinkCredentialNotFoundError(entry.serverId, entry.message);
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
  const existing = inFlightPrewarm.get(serverId);
  if (existing) return existing;
  const cached = getCachedTools(serverId, config);
  if (cached) {
    return Promise.resolve({ ok: true, tools: cached });
  }

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
      inFlightPrewarm.delete(serverId);
    }
  })();

  inFlightPrewarm.set(serverId, promise);
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

  if (
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
