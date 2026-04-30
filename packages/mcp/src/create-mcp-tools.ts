/**
 * Creates per-caller MCP tool connections from server configs.
 *
 * Stdio MCP children are owned by their transport and die when the client
 * closes. HTTP-with-startup children (e.g. workspace-mcp on a fixed port)
 * are owned by the daemon-scoped `sharedMCPProcesses` registry and survive
 * across `createMCPTools` calls.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { spawn as defaultSpawn } from "node:child_process";
import process from "node:process";
import { Writable } from "node:stream";
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
import { getFridayHome } from "@atlas/utils/paths.server";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RetryError, type RetryOptions, retry } from "@std/async/retry";
import type { Tool } from "ai";
import { type PidFileWriter, sharedMCPProcesses } from "./process-registry.ts";

/** ai doesn't export the MCPClient type, so we infer it. */
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

const RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  multiplier: 1, // constant backoff
  minTimeout: 1000,
  maxTimeout: 3000,
};

export { MCPAuthError, MCPStartupError } from "./errors.ts";

import { MCPAuthError, MCPStartupError } from "./errors.ts";

/** Result of creating MCP tools — tools map + cleanup callback. */
export interface MCPToolsResult {
  tools: Record<string, Tool>;
  dispose: () => Promise<void>;
}

/** Unwrap a RetryError so the real underlying error is surfaced. */
function unwrapError(error: unknown): unknown {
  if (error instanceof RetryError && error.cause) {
    return error.cause;
  }
  return error;
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
  const allTools: Record<string, Tool> = {};
  let disposed = false;

  const signal = options?.signal;

  for (const [serverId, config] of Object.entries(configs)) {
    if (signal?.aborted) {
      await disposeAll(clients);
      throw signal.reason ?? new Error("Aborted");
    }

    try {
      const resolvedEnv = config.env ? await resolveEnvValues(config.env, logger) : {};

      const connected = await connectServer(config, resolvedEnv, serverId, logger);
      clients.push(connected.client);

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
        await disposeAll(clients);

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
      await disposeAll(clients);

      if (error instanceof MCPStartupError) {
        throw error;
      }

      const actualError = unwrapError(error);

      // HTTP 401 from the transport is an auth failure, not a connection failure.
      if (
        config.transport.type === "http" &&
        actualError instanceof StreamableHTTPError &&
        actualError.code === 401
      ) {
        throw new MCPAuthError(serverId, config.transport.url, actualError.message);
      }

      const command =
        config.transport.type === "stdio"
          ? `${config.transport.command} ${(config.transport.args ?? []).join(" ")}`.trim()
          : config.transport.url;
      const reason = actualError instanceof Error ? actualError.message : String(actualError);
      // Omit the generic install hint when the reason already contains specific
      // process output (e.g. ENOENT from a bad root path) — it's misleading there.
      const hint =
        reason.includes("\n") || reason.includes("ENOENT") || reason.includes("Error:")
          ? ""
          : " Check that the command is installed and available in the container.";
      throw new Error(`MCP server "${serverId}" failed to start (${command}): ${reason}.${hint}`);
    }
  }

  return {
    tools: allTools,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await disposeAll(clients);
    },
  };
}

/**
 * Close MCP clients. Stdio subprocesses are killed by their transport when
 * the client closes. HTTP-with-startup children are owned by the daemon-scoped
 * `sharedMCPProcesses` registry and survive across `createMCPTools` calls.
 */
async function disposeAll(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}

/** Client + tools fetched during connection. */
interface ConnectedServer {
  client: MCPClient;
  tools: Record<string, Tool>;
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
      return await connectStdio(transport, resolvedEnv, serverId, logger);
    case "http":
      return await connectHttp(config, resolvedEnv, serverId, logger);
  }
}

/**
 * Expand `${HOME}` / `${FRIDAY_HOME}` inside a single string value. Friday
 * regularly guesses the wrong username when asked to write absolute paths
 * in workspace.yml, which 3-retries into "MCP server failed to start" and
 * silently strips the sqlite/fs tools from the agent. Supporting portable
 * placeholders in args lets templates stay stable across machines and
 * sidesteps the guessed-username failure mode entirely.
 *
 * Only two placeholders are interpolated — both resolve from the
 * daemon's own environment, so there's no way a workspace.yml can
 * smuggle in a value that escapes the user's own scope.
 */
function interpolateArg(arg: string): string {
  const home = process.env.HOME ?? "";
  return arg.replaceAll("${HOME}", home).replaceAll("${FRIDAY_HOME}", getFridayHome());
}

async function connectStdio(
  transport: Extract<MCPServerConfig["transport"], { type: "stdio" }>,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
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

  let attempt = 0;
  return await retry(async () => {
    attempt++;
    logger.debug(`MCP stdio connection attempt ${attempt} for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      command,
      args: expandedArgs,
      attempt,
    });

    // Capture subprocess stderr so startup errors (e.g. ENOENT on a root path)
    // are included in the thrown error instead of silently dropped.
    const stderrChunks: Buffer[] = [];
    const stderrCapture = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderrChunks.push(chunk);
        callback();
      },
    });

    const client = await createMCPClient({
      transport: new StdioMCPTransport({
        command,
        args: expandedArgs,
        env: mergedEnv,
        stderr: stderrCapture,
      }),
    });

    // Verify the subprocess is actually responding AND capture tools in one call.
    // createMCPClient can succeed for stdio even when the server isn't ready yet.
    let tools: Record<string, Tool>;
    try {
      tools = await client.tools();
    } catch (err) {
      // Close the client to kill the orphaned subprocess before retry
      await client.close().catch(() => {});
      const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
      logger.debug(`MCP stdio tools() failed on attempt ${attempt} for "${serverId}"`, {
        operation: "mcp_connect",
        serverId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
        stderrOutput: stderrOutput || undefined,
      });
      // Prepend subprocess stderr to the error message so callers see the
      // actual failure reason (e.g. "ENOENT: no such file or directory")
      // rather than just the generic "Connection closed" from the transport.
      if (stderrOutput && err instanceof Error) {
        err.message = `${stderrOutput} (${err.message})`;
      }
      throw err;
    }

    logger.debug(`MCP stdio connected on attempt ${attempt} for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      attempt,
    });

    return { client, tools };
  }, RETRY_OPTIONS);
}

/**
 * Check whether an HTTP server is listening on the given URL.
 * Any successful HTTP response (even 404) means the server is up;
 * only connection-level errors (ECONNREFUSED, etc.) return false.
 * MCP HTTP endpoints typically reject GET with 404/405, so requiring
 * 2xx would falsely report them as unreachable.
 */
async function isReachable(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetchImpl(url, { method: "GET" });
    return { ok: true, status: res.status };
  } catch {
    return { ok: false };
  }
}

/** Connect to an HTTP MCP server, with optional auto-startup. */
export async function connectHttp(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
  deps: { spawn?: typeof defaultSpawn; fetch?: typeof fetch; pidFile?: PidFileWriter } = {},
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
  const reachable = await isReachable(url, _fetch);
  logger.debug(`MCP HTTP reachable check for "${serverId}"`, {
    operation: "mcp_connect",
    serverId,
    url,
    reachable: reachable.ok,
    status: reachable.status,
  });
  if (reachable.ok) {
    return connectHttpClient(url, headers, serverId, logger);
  }

  // No startup config — try direct connection (will likely fail, matching old behaviour).
  if (!startup) {
    return connectHttpClient(url, headers, serverId, logger);
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

  // Delegate spawn + readiness polling to the daemon-scoped process registry.
  // The registry keeps a single child alive across `createMCPTools` invocations,
  // eliminating the kernel TIME_WAIT respawn failures that broke FSM workflows
  // reusing the same MCP server across sequential states. The registry — not
  // this caller — owns the child's lifetime; `dispose` closes the MCP client
  // only.
  await sharedMCPProcesses.acquire(
    serverId,
    {
      command: startup.command,
      args: startup.args ?? [],
      env: mergedEnv,
      readyUrl: startup.ready_url ?? url,
      readyTimeoutMs: startup.ready_timeout_ms ?? 30000,
      readyIntervalMs: startup.ready_interval_ms ?? 500,
    },
    { spawn: _spawn, fetch: _fetch, pidFile: deps.pidFile },
    logger,
  );

  return connectHttpClient(url, headers, serverId, logger);
}

/** Create MCP client over HTTP transport and verify with tools(). */
async function connectHttpClient(
  url: string,
  headers: Record<string, string>,
  serverId: string,
  logger: Logger,
): Promise<ConnectedServer> {
  let attempt = 0;
  return await retry(async () => {
    attempt++;
    logger.debug(`MCP HTTP connection attempt ${attempt} for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      url,
      attempt,
    });

    const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
    });

    const client = await createMCPClient({ transport: httpTransport });

    let tools: Record<string, Tool>;
    try {
      tools = await client.tools();
    } catch (err) {
      logger.debug(`MCP HTTP tools() failed on attempt ${attempt} for "${serverId}"`, {
        operation: "mcp_connect",
        serverId,
        url,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      await client.close().catch(() => {});
      throw err;
    }

    logger.debug(`MCP HTTP connected on attempt ${attempt} for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      url,
      attempt,
    });

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
