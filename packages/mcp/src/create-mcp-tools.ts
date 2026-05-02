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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "ai";
import { type PidFileWriter, sharedMCPProcesses } from "./process-registry.ts";

/** ai doesn't export the MCPClient type, so we infer it. */
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

/** Hard timeout for the HTTP reachability probe. */
const REACHABLE_TIMEOUT_MS = 4_000;

/** Hard timeout for `createMCPClient` handshake + `listTools` per server. */
const LIST_TOOLS_TIMEOUT_MS = 20_000;

/** Hard ceiling for a single MCP tool invocation. */
const CALL_TOOL_TIMEOUT_MS = 15 * 60 * 1_000;

export { MCPStartupError, MCPTimeoutError } from "./errors.ts";

import { MCPTimeoutError } from "./errors.ts";

export type DisconnectedIntegrationKind =
  | "credential_not_found"
  | "credential_expired"
  | "credential_refresh_failed"
  | "no_default_credential";

/** A skipped MCP server whose credentials are unusable. Carries enough info for the UI to prompt a reconnect. */
export interface DisconnectedIntegration {
  serverId: string;
  provider?: string;
  kind: DisconnectedIntegrationKind;
  message: string;
}

/** Result of creating MCP tools — tools map, cleanup callback, and any servers skipped due to dead credentials. */
export interface MCPToolsResult {
  tools: Record<string, Tool>;
  /**
   * Per-server tool name index. Same merge order as `tools`, so a tool name
   * present in `tools` is also present here under the server that won the
   * collision. Callers that need per-server filtering (e.g. enforcing a
   * per-agent `tools:` whitelist) read this; callers that only need the
   * flat tool map ignore it.
   */
  toolsByServer: Record<string, string[]>;
  dispose: () => Promise<void>;
  disconnected: DisconnectedIntegration[];
}

/** Race a promise against a timeout, clearing the timer when the promise settles. */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: (actualDurationMs: number) => Error,
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError(Date.now() - startedAt)), timeoutMs);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeoutPromise]);
}

/** Add the 15-minute hard ceiling to a single tool's execute. */
function wrapToolWithTimeout(tool: Tool, serverId: string): Tool {
  return {
    ...tool,
    execute: (args, opts) => {
      return withTimeout(
        tool.execute!(args, opts),
        CALL_TOOL_TIMEOUT_MS,
        (actualDurationMs) =>
          new MCPTimeoutError(serverId, "call_tool", CALL_TOOL_TIMEOUT_MS, actualDurationMs),
      );
    },
  };
}

export interface CreateMCPToolsOptions {
  /** Signal to abort connection attempts early (e.g., on agent cancellation). */
  signal?: AbortSignal;
  /** Prefix all tool keys with `{toolPrefix}_` in the returned tools map. */
  toolPrefix?: string;
}

/** Internal result of attempting to connect a single server. */
type ServerConnectResult =
  | { status: "success"; serverId: string; client: MCPClient; tools: Record<string, Tool> }
  | { status: "disconnected"; entry: DisconnectedIntegration }
  | { status: "failed"; serverId: string; error: unknown };

/**
 * Connect to MCP servers in parallel, fetch tools, return a dispose callback.
 *
 * Servers whose Link credentials are missing/expired/un-refreshable are skipped
 * and reported in `disconnected`. All other failures (transport, startup,
 * timeout) silently drop that server — the chat continues with whatever
 * servers connected. Every timeout emits a structured `warn` log.
 */
export async function createMCPTools(
  configs: Record<string, MCPServerConfig>,
  logger: Logger,
  options?: CreateMCPToolsOptions,
): Promise<MCPToolsResult> {
  const signal = options?.signal;

  if (signal?.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }

  const results = await Promise.allSettled(
    Object.entries(configs).map(async ([serverId, config]): Promise<ServerConnectResult> => {
      try {
        const resolvedEnv = config.env ? await resolveEnvValues(config.env, logger) : {};
        const connected = await connectServerWithTimeout(config, resolvedEnv, serverId, logger);
        const filtered = filterTools(connected.tools, config.tools);
        const prefixed = options?.toolPrefix
          ? prefixToolKeys(filtered, options.toolPrefix)
          : filtered;
        return { status: "success", serverId, client: connected.client, tools: prefixed };
      } catch (error) {
        if (
          error instanceof LinkCredentialNotFoundError ||
          error instanceof LinkCredentialExpiredError ||
          error instanceof NoDefaultCredentialError
        ) {
          const entry = buildDisconnectedEntry(error, serverId, config);
          return { status: "disconnected", entry };
        }

        return { status: "failed", serverId, error };
      }
    }),
  );

  // If the parent signal aborted while connections were in flight, clean up
  // anything that managed to connect and re-throw.
  if (signal?.aborted) {
    const connectedClients = results
      .filter(
        (r): r is PromiseFulfilledResult<ServerConnectResult> =>
          r.status === "fulfilled" && r.value.status === "success",
      )
      .map(
        (r) =>
          (r as PromiseFulfilledResult<Extract<ServerConnectResult, { status: "success" }>>).value
            .client,
      );
    await disposeAll(connectedClients);
    throw signal.reason ?? new Error("Aborted");
  }

  const clients: MCPClient[] = [];
  const allTools: Record<string, Tool> = {};
  const toolsByServer: Record<string, string[]> = {};
  const disconnected: DisconnectedIntegration[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      // Defensive: shouldn't happen since each mapper catches its own errors.
      await disposeAll(clients);
      throw result.reason;
    }

    const value = result.value;

    if (value.status === "disconnected") {
      disconnected.push(value.entry);
      logger.warn(`MCP server skipped due to credential issue`, {
        operation: "mcp_connect",
        serverId: value.entry.serverId,
        kind: value.entry.kind,
        provider: value.entry.provider,
        reason: value.entry.message,
      });
      continue;
    }

    if (value.status === "failed") {
      const error = value.error;
      if (error instanceof MCPTimeoutError) {
        logger.warn("MCP operation timed out", {
          operation: "mcp_timeout",
          serverId: error.serverId,
          phase: error.phase,
          timeoutMs: error.timeoutMs,
          durationMs: error.actualDurationMs,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("MCP server skipped due to connection error", {
          operation: "mcp_connect",
          serverId: value.serverId,
          error: message,
        });
      }
      continue;
    }

    // status === "success"
    const wrappedTools = Object.fromEntries(
      Object.entries(value.tools).map(([name, tool]) => [
        name,
        wrapToolWithTimeout(tool, value.serverId),
      ]),
    );

    const clobbered = Object.keys(wrappedTools).filter((name) => name in allTools);
    if (clobbered.length > 0) {
      logger.warn(`MCP tool name collision: server "${value.serverId}" overwrites existing tools`, {
        operation: "mcp_connect",
        serverId: value.serverId,
        clobberedTools: clobbered,
      });
    }
    Object.assign(allTools, wrappedTools);
    toolsByServer[value.serverId] = Object.keys(wrappedTools);
    clients.push(value.client);

    logger.info(`Connected MCP server`, {
      operation: "mcp_connect",
      serverId: value.serverId,
      toolCount: Object.keys(wrappedTools).length,
    });
  }

  let disposed = false;

  return {
    tools: allTools,
    toolsByServer,
    disconnected,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await disposeAll(clients);
    },
  };
}

/**
 * Translate a credential-resolution error into a structured `DisconnectedIntegration`
 * record. Re-builds the error with the originating `serverId` so the message
 * names the integration the user recognises (matches the prior re-throw
 * enrichment).
 */
function buildDisconnectedEntry(
  error: LinkCredentialNotFoundError | LinkCredentialExpiredError | NoDefaultCredentialError,
  serverId: string,
  config: MCPServerConfig,
): DisconnectedIntegration {
  if (error instanceof NoDefaultCredentialError) {
    return {
      serverId,
      provider: error.provider,
      kind: "no_default_credential",
      message: error.message,
    };
  }
  if (error instanceof LinkCredentialNotFoundError) {
    const enriched = error.serverName
      ? error
      : new LinkCredentialNotFoundError(error.credentialId, serverId);
    return {
      serverId,
      provider: extractProviderFromConfig(config),
      kind: "credential_not_found",
      message: enriched.message,
    };
  }
  const enriched = error.serverName
    ? error
    : new LinkCredentialExpiredError(error.credentialId, error.status, serverId);
  return {
    serverId,
    provider: extractProviderFromConfig(config),
    kind:
      error.status === "expired_no_refresh" ? "credential_expired" : "credential_refresh_failed",
    message: enriched.message,
  };
}

/** Best-effort: pull the first `from: "link"` provider out of the server's env config. */
function extractProviderFromConfig(config: MCPServerConfig): string | undefined {
  if (!config.env) return undefined;
  for (const value of Object.values(config.env)) {
    if (typeof value === "object" && value.from === "link" && value.provider) {
      return value.provider;
    }
  }
  return undefined;
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
 * Connect a single MCP server with a hard timeout on the full handshake +
 * listTools sequence. No retry — a hung server is not a transient failure.
 */
function connectServerWithTimeout(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
): Promise<ConnectedServer> {
  return withTimeout(
    connectServer(config, resolvedEnv, serverId, logger),
    LIST_TOOLS_TIMEOUT_MS,
    (actualDurationMs) =>
      new MCPTimeoutError(serverId, "list_tools", LIST_TOOLS_TIMEOUT_MS, actualDurationMs),
  );
}

/** Connect a single MCP server (stdio or HTTP). */
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

  logger.debug(`MCP stdio connection attempt for "${serverId}"`, {
    operation: "mcp_connect",
    serverId,
    command,
    args: expandedArgs,
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
    // Close the client to kill the orphaned subprocess before re-throwing
    await client.close().catch(() => {});
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
    logger.debug(`MCP stdio tools() failed for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
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

  logger.debug(`MCP stdio connected for "${serverId}"`, { operation: "mcp_connect", serverId });

  return { client, tools };
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
  serverId: string,
  logger: Logger,
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await withTimeout(
      fetchImpl(url, { method: "GET" }),
      REACHABLE_TIMEOUT_MS,
      (actualDurationMs) =>
        new MCPTimeoutError(serverId, "reachable", REACHABLE_TIMEOUT_MS, actualDurationMs),
    );
    return { ok: true, status: res.status };
  } catch (err) {
    if (err instanceof MCPTimeoutError) {
      logger.warn("MCP operation timed out", {
        operation: "mcp_timeout",
        serverId: err.serverId,
        phase: err.phase,
        timeoutMs: err.timeoutMs,
        durationMs: err.actualDurationMs,
      });
    }
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
  const reachable = await isReachable(url, _fetch, serverId, logger);
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
  logger.debug(`MCP HTTP connection attempt for "${serverId}"`, {
    operation: "mcp_connect",
    serverId,
    url,
  });

  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });

  const client = await createMCPClient({ transport: httpTransport });

  let tools: Record<string, Tool>;
  try {
    tools = await client.tools();
  } catch (err) {
    logger.debug(`MCP HTTP tools() failed for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    await client.close().catch(() => {});
    throw err;
  }

  logger.debug(`MCP HTTP connected for "${serverId}"`, { operation: "mcp_connect", serverId, url });

  return { client, tools };
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
