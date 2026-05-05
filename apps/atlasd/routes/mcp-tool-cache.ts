import type { MCPServerConfig } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";

export type CachedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown> | null;
};

type Entry = { configHash: string; tools: CachedTool[]; cachedAt: number };

const CACHE_TTL_MS = 60 * 60 * 1000;
const PREWARM_TIMEOUT_MS = 60_000;

const cache = new Map<string, Entry>();
const inFlightPrewarm = new Map<string, Promise<void>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hashConfig(config: MCPServerConfig): string {
  return stableStringify(config);
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

export function _resetCacheForTest(): void {
  cache.clear();
  inFlightPrewarm.clear();
}

export async function _flushPrewarmsForTest(): Promise<void> {
  await Promise.allSettled(inFlightPrewarm.values());
}

export async function probeAndExtract(
  serverId: string,
  config: MCPServerConfig,
  logger: Logger,
  timeoutMs: number,
): Promise<CachedTool[]> {
  const result = await createMCPTools({ [serverId]: config }, logger, {
    signal: AbortSignal.timeout(timeoutMs),
  });
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
 * Best-effort background probe. Caches the tool list on success so the next
 * `GET /:id/tools` is instant. Failures are swallowed (logged at debug) — the
 * foreground probe will surface a real error if the user clicks before the
 * prewarm finishes. Generous timeout covers cold `npx`/`uvx` package downloads.
 */
export function prewarmTools(
  serverId: string,
  config: MCPServerConfig,
  logger: Logger,
): Promise<void> {
  if (inFlightPrewarm.has(serverId)) {
    return inFlightPrewarm.get(serverId)!;
  }
  if (getCachedTools(serverId, config)) {
    return Promise.resolve();
  }

  const promise = (async () => {
    try {
      const tools = await probeAndExtract(serverId, config, logger, PREWARM_TIMEOUT_MS);
      putCachedTools(serverId, config, tools);
      logger.debug("MCP tools prewarmed", { serverId, toolCount: tools.length });
    } catch (error) {
      logger.debug("MCP tools prewarm failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlightPrewarm.delete(serverId);
    }
  })();

  inFlightPrewarm.set(serverId, promise);
  return promise;
}
