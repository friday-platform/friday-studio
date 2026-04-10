/**
 * Creates ephemeral MCP tool connections from server configs.
 * Single function replaces the MCPManager class — no pooling, no sharing, no ref counting.
 *
 * @module
 */

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

/** Result of creating MCP tools — tools map + cleanup callback. */
export interface MCPToolsResult {
  tools: Record<string, Tool>;
  dispose: () => Promise<void>;
}

export interface CreateMCPToolsOptions {
  /** Signal to abort connection attempts early (e.g., on agent cancellation). */
  signal?: AbortSignal;
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
      await Promise.allSettled(clients.map((c) => c.close()));
      throw signal.reason ?? new Error("Aborted");
    }

    try {
      const resolvedEnv = config.env ? await resolveEnvValues(config.env, logger) : {};

      const connected = await connectServer(config, resolvedEnv);
      clients.push(connected.client);

      const filtered = filterTools(connected.tools, config.tools);

      const clobbered = Object.keys(filtered).filter((name) => name in allTools);
      if (clobbered.length > 0) {
        logger.warn(`MCP tool name collision: server "${serverId}" overwrites existing tools`, {
          operation: "mcp_connect",
          serverId,
          clobberedTools: clobbered,
        });
      }

      Object.assign(allTools, filtered);

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
        await Promise.allSettled(clients.map((c) => c.close()));

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
      await Promise.allSettled(clients.map((c) => c.close()));

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
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
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
): Promise<ConnectedServer> {
  const { transport } = config;
  switch (transport.type) {
    case "stdio":
      return await connectStdio(transport, resolvedEnv);
    case "http":
      return await connectHttp(transport, config.auth, resolvedEnv);
  }
}

async function connectStdio(
  transport: Extract<MCPServerConfig["transport"], { type: "stdio" }>,
  resolvedEnv: Record<string, string>,
): Promise<ConnectedServer> {
  const { command, args } = transport;

  // Merge resolved env with parent process env (subprocess needs PATH etc.)
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const mergedEnv = { ...parentEnv, ...resolvedEnv };

  return await retry(async () => {
    const client = await createMCPClient({
      transport: new StdioMCPTransport({ command, args: args ?? [], env: mergedEnv }),
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

async function connectHttp(
  transport: Extract<MCPServerConfig["transport"], { type: "http" }>,
  auth: MCPServerConfig["auth"],
  resolvedEnv: Record<string, string>,
): Promise<ConnectedServer> {
  const { url } = transport;

  const headers = buildAuthHeaders(auth, resolvedEnv);

  // Retry covers both transport creation AND tools() — matching stdio behavior.
  // StreamableHTTPClientTransport overwrites requestInit.signal with its own
  // internal AbortController, so no application-level timeout needed.
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
