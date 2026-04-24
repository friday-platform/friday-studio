/**
 * Creates ephemeral MCP tool connections from server configs.
 * Single function replaces the MCPManager class — no pooling, no sharing, no ref counting.
 *
 * @module
 */

import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";
import process from "node:process";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { MCPServerConfig, MCPServerToolFilter } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  NoDefaultCredentialError,
  resolveEnvValues,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { Logger } from "@atlas/logger";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type RetryOptions, retry } from "@std/async/retry";
import type { Tool } from "ai";

/** ai doesn't export the MCPClient type, so we infer it. */
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

const RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  multiplier: 1, // constant backoff
  minTimeout: 1000,
  maxTimeout: 3000,
};

/** Error thrown when an MCP HTTP server fails to start up. */
export class MCPStartupError extends Error {
  constructor(
    public readonly kind: "spawn" | "timeout" | "connect",
    public readonly serverId: string,
    public readonly command?: string,
    override readonly cause?: unknown,
  ) {
    super(`MCP server "${serverId}" startup failed (${kind})${command ? `: ${command}` : ""}`);
    this.name = "MCPStartupError";
  }
}

/** Result of creating MCP tools — tools map + cleanup callback. */
export interface MCPToolsResult {
  tools: Record<string, Tool>;
  dispose: () => Promise<void>;
}

export interface CreateMCPToolsOptions {
  /** Signal to abort connection attempts early (e.g., on agent cancellation). */
  signal?: AbortSignal;
  /** Prefix all tool keys with `{toolPrefix}_` in the returned tools map. */
  toolPrefix?: string;
}

/**
 * Connect to MCP servers, fetch tools, return a dispose callback.
 * Throws on any server connection failure — credential errors and startup failures alike.
 */
export async function createMCPTools(
  configs: Record<string, MCPServerConfig>,
  logger: Logger,
  options?: CreateMCPToolsOptions,
): Promise<MCPToolsResult> {
  const clients: MCPClient[] = [];
  const allChildren = new Set<ChildProcess>();
  const allTools: Record<string, Tool> = {};
  let disposed = false;

  const signal = options?.signal;

  for (const [serverId, config] of Object.entries(configs)) {
    if (signal?.aborted) {
      await disposeAll(clients, allChildren);
      throw signal.reason ?? new Error("Aborted");
    }

    try {
      const resolvedEnv = config.env ? await resolveEnvValues(config.env, logger) : {};

      const connected = await connectServer(config, resolvedEnv, serverId, logger);
      clients.push(connected.client);
      if (connected.children) {
        for (const child of connected.children) {
          allChildren.add(child);
        }
      }

      const filtered = filterTools(connected.tools, config.tools);
      const prefixed = options?.toolPrefix
        ? prefixToolKeys(filtered, options.toolPrefix)
        : filtered;

      const clobbered = Object.keys(prefixed).filter((name) => name in allTools);
      if (clobbered.length > 0) {
        logger.warn(`MCP tool name collision: server "${serverId}" overwrites existing tools`, {
          operation: "mcp_connect",
          serverId,
          clobberedTools: clobbered,
        });
      }

      Object.assign(allTools, prefixed);

      logger.info(`Connected MCP server: ${serverId}`, {
        operation: "mcp_connect",
        serverId,
        toolCount: Object.keys(filtered).length,
      });
    } catch (error) {
      if (
        error instanceof LinkCredentialNotFoundError ||
        error instanceof LinkCredentialExpiredError ||
        error instanceof NoDefaultCredentialError
      ) {
        // Clean up any already-connected clients before re-throwing
        await disposeAll(clients, allChildren);

        // Enrich with server name if not already set
        if (error instanceof LinkCredentialNotFoundError && !error.serverName) {
          const enriched = new LinkCredentialNotFoundError(error.credentialId, serverId);
          enriched.cause = error;
          throw enriched;
        }
        if (error instanceof LinkCredentialExpiredError && !error.serverName) {
          const enriched = new LinkCredentialExpiredError(
            error.credentialId,
            error.status,
            serverId,
          );
          enriched.cause = error;
          throw enriched;
        }
        throw error;
      }

      // Clean up any already-connected clients before throwing
      await disposeAll(clients, allChildren);

      if (error instanceof MCPStartupError) {
        throw error;
      }

      const command =
        config.transport.type === "stdio"
          ? `${config.transport.command} ${(config.transport.args ?? []).join(" ")}`.trim()
          : config.transport.url;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `MCP server "${serverId}" failed to start (${command}): ${reason}. ` +
          `Check that the command is installed and available in the container.`,
      );
    }
  }

  return {
    tools: allTools,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await disposeAll(clients, allChildren);
    },
  };
}

/** Dispose all clients and child processes. */
async function disposeAll(clients: MCPClient[], children: Set<ChildProcess>): Promise<void> {
  // Send SIGTERM to all living children
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }

  // Wait grace period
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // SIGKILL survivors
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  // Brief pause for SIGKILL to take effect
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Close MCP clients
  await Promise.allSettled(clients.map((c) => c.close()));
}

/** Client + tools fetched during connection. */
interface ConnectedServer {
  client: MCPClient;
  tools: Record<string, Tool>;
  children?: Set<ChildProcess>;
}

/**
 * Connect a single MCP server with retry and fetch tools.
 * Both stdio and HTTP retry the full connect + tools() sequence.
 */
async function connectServer(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
): Promise<ConnectedServer> {
  const { transport } = config;
  switch (transport.type) {
    case "stdio":
      return await connectStdio(transport, resolvedEnv);
    case "http":
      return await connectHttp(config, resolvedEnv, serverId, logger);
  }
}

/**
 * Expand `${HOME}` / `${ATLAS_HOME}` inside a single string value. Friday
 * regularly hallucinates usernames when asked to write absolute paths in
 * workspace.yml (e.g. `/Users/yena/...` when the real user is `yenaoh`),
 * which 3-retries into "MCP server failed to start" and silently strips
 * the sqlite/fs tools from the agent. Supporting portable placeholders
 * in args lets templates stay stable across machines and sidesteps the
 * guessed-username failure mode entirely.
 *
 * Only two placeholders are interpolated — both resolve from the
 * daemon's own environment, so there's no way a workspace.yml can
 * smuggle in a value that escapes the user's own scope.
 */
function interpolateArg(arg: string): string {
  const home = process.env.HOME ?? "";
  const atlasHome = process.env.ATLAS_HOME ?? (home ? `${home}/.atlas` : "");
  return arg.replaceAll("${HOME}", home).replaceAll("${ATLAS_HOME}", atlasHome);
}

async function connectStdio(
  transport: Extract<MCPServerConfig["transport"], { type: "stdio" }>,
  resolvedEnv: Record<string, string>,
): Promise<ConnectedServer> {
  const { command, args } = transport;
  const expandedArgs = (args ?? []).map(interpolateArg);

  // Merge resolved env with parent process env (subprocess needs PATH etc.)
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const mergedEnv = { ...parentEnv, ...resolvedEnv };

  return await retry(async () => {
    const client = await createMCPClient({
      transport: new StdioMCPTransport({ command, args: expandedArgs, env: mergedEnv }),
    });

    // Verify the subprocess is actually responding AND capture tools in one call.
    // createMCPClient can succeed for stdio even when the server isn't ready yet.
    let tools: Record<string, Tool>;
    try {
      tools = await client.tools();
    } catch (err) {
      // Close the client to kill the orphaned subprocess before retry
      await client.close().catch(() => {});
      throw err;
    }

    return { client, tools };
  }, RETRY_OPTIONS);
}

/** Check whether an HTTP URL returns a 2xx response. */
async function isReachable(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const resp = await fetchImpl(url, { method: "GET" });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  }
}

/** Connect to an HTTP MCP server, with optional auto-startup. */
export async function connectHttp(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
  deps: { spawn?: typeof defaultSpawn; fetch?: typeof fetch } = {},
): Promise<ConnectedServer> {
  const { transport, auth, startup } = config;
  if (transport.type !== "http") {
    throw new Error("Expected HTTP transport");
  }

  const { url } = transport;
  const _fetch = deps.fetch ?? fetch;
  const _spawn = deps.spawn ?? defaultSpawn;

  const headers = buildAuthHeaders(auth, resolvedEnv);

  // If already reachable, connect directly — no spawn needed.
  if (await isReachable(url, _fetch)) {
    return connectHttpClient(url, headers);
  }

  // No startup config — try direct connection (will likely fail, matching old behaviour).
  if (!startup) {
    return connectHttpClient(url, headers);
  }

  // Resolve startup.env separately from config.env — bearer tokens must never
  // leak into the child process, and startup.env must never reach HTTP headers.
  const resolvedStartupEnv = startup.env ? await resolveEnvValues(startup.env, logger) : {};

  // Merge parent env + resolved startup env (with interpolation)
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  const mergedEnv: Record<string, string> = {
    ...parentEnv,
    ...Object.fromEntries(
      Object.entries(resolvedStartupEnv).map(([k, v]) => [k, interpolateArg(v)]),
    ),
  };

  const { command, args = [] } = startup;
  const pollUrl = startup.ready_url ?? url;
  const timeoutMs = startup.ready_timeout_ms ?? 30000;
  const intervalMs = startup.ready_interval_ms ?? 500;

  // Spawn the startup command
  let child: ChildProcess;
  try {
    child = _spawn(command, args, {
      env: mergedEnv,
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    throw new MCPStartupError("spawn", serverId, command, err);
  }

  // Collect stderr for EADDRINUSE detection
  let stderrAccumulator = "";
  child.stderr?.on("data", (data: Uint8Array) => {
    stderrAccumulator += new TextDecoder().decode(data);
  });

  let childExited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    exitCode = code;
  });

  // Poll until reachable or timeout
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    // If child exited early with error, check for EADDRINUSE fallback
    if (childExited && exitCode !== 0) {
      const eaddrInUse =
        stderrAccumulator.includes("EADDRINUSE") ||
        stderrAccumulator.includes("address already in use");
      if (eaddrInUse) {
        // Another instance may already be listening — re-check reachability
        if (await isReachable(url, _fetch)) {
          return connectHttpClient(url, headers);
        }
      }
      throw new MCPStartupError(
        "spawn",
        serverId,
        command,
        new Error(stderrAccumulator || `Process exited with code ${exitCode}`),
      );
    }

    try {
      const resp = await _fetch(pollUrl, { method: "GET" });
      if (resp.status >= 200 && resp.status < 300) {
        const result = await connectHttpClient(url, headers);
        return { ...result, children: new Set([child]) };
      }
    } catch {
      // Not ready yet — continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Timeout — terminate the child and throw
  if (!child.killed) {
    child.kill("SIGTERM");
  }
  throw new MCPStartupError("timeout", serverId, command);
}

/** Create MCP client over HTTP transport and verify with tools(). */
async function connectHttpClient(
  url: string,
  headers: Record<string, string>,
): Promise<ConnectedServer> {
  return await retry(async () => {
    const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
    });

    const client = await createMCPClient({ transport: httpTransport });

    let tools: Record<string, Tool>;
    try {
      tools = await client.tools();
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }

    return { client, tools };
  }, RETRY_OPTIONS);
}

/** Build bearer auth headers from config + resolved env. */
function buildAuthHeaders(
  auth: MCPServerConfig["auth"],
  resolvedEnv: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!auth) return headers;

  if (auth.type === "bearer" && auth.token_env) {
    const token = resolvedEnv[auth.token_env] ?? process.env[auth.token_env];
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

/** Apply allow/deny tool filtering from server config. */
function filterTools(
  tools: Record<string, Tool>,
  filterConfig?: MCPServerToolFilter,
): Record<string, Tool> {
  if (!filterConfig) return tools;

  const filtered: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (filterConfig.allow && !filterConfig.allow.includes(name)) continue;
    if (filterConfig.deny?.includes(name)) continue;
    filtered[name] = tool;
  }
  return filtered;
}

/** Prefix every key in a tools map with `{prefix}_`. Descriptions are unmodified. */
function prefixToolKeys(tools: Record<string, Tool>, prefix: string): Record<string, Tool> {
  const prefixed: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    prefixed[`${prefix}_${name}`] = tool;
  }
  return prefixed;
}
