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
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { MCPServerConfig, MCPServerToolFilter } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
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
  | "credential_temporarily_unavailable"
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

/**
 * Race a promise against a timeout, clearing the timer when the promise settles.
 *
 * When `signal` is supplied, the race also rejects with `signal.reason` if the
 * signal aborts before the timer fires. The timer is cleared on every exit path
 * (settle, timeout, abort) so no zombie `setTimeout` is left behind.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: (actualDurationMs: number) => Error,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    // Caller already constructed `promise`; swallow any future rejection so
    // it doesn't bubble up as an unhandled rejection after we short-circuit.
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(makeError(Date.now() - startedAt));
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort);
    }
  });
  // If the timer or signal wins the race, the inner promise is orphaned and
  // may reject later (e.g. when `attemptStdio`'s post-abort signal check
  // throws). Attach a no-op handler so that orphan doesn't bubble up as an
  // unhandled rejection — the race result already settled with the right
  // reason for the caller.
  promise.catch(() => {});
  return Promise.race([promise.finally(cleanup), timeoutPromise]);
}

/** Add the 15-minute hard ceiling to a single tool's execute. */
function wrapToolWithTimeout(tool: Tool, serverId: string): Tool {
  return {
    ...tool,
    execute: (args, opts) => {
      return withTimeout(
        tool.execute?.(args, opts),
        CALL_TOOL_TIMEOUT_MS,
        (actualDurationMs) =>
          new MCPTimeoutError(serverId, "call_tool", CALL_TOOL_TIMEOUT_MS, actualDurationMs),
      );
    },
  };
}

/**
 * Optional post-processor for tool results. Receives whatever the MCP tool
 * returned, plus context about which server/tool produced it, and returns a
 * possibly-rewritten value. Used by chat callers to lift oversized binary
 * (PDF base64, data URLs, etc.) out of tool outputs before they enter the
 * AI SDK message buffer — keeps prompt tokens down and avoids
 * `MAX_PAYLOAD_EXCEEDED` at chat-message persist time.
 *
 * Generic (non-chat) callers leave this unset and get the unmodified result.
 */
export type ScrubToolResult = (
  result: unknown,
  ctx: { serverId: string; toolName: string },
) => Promise<unknown>;

/** Wrap a tool's execute with timeout + optional result scrubbing. */
function wrapTool(tool: Tool, serverId: string, toolName: string, scrub?: ScrubToolResult): Tool {
  const timed = wrapToolWithTimeout(tool, serverId);
  if (!scrub) return timed;
  return {
    ...timed,
    execute: async (args, opts) => {
      const result = await timed.execute?.(args, opts);
      try {
        return await scrub(result, { serverId, toolName });
      } catch {
        // Scrub failures must not break tool execution — pass through the
        // original result. The caller's pre-persist scrubber (if present)
        // is the second line of defense.
        return result;
      }
    },
  };
}

export interface CreateMCPToolsOptions {
  /** Signal to abort connection attempts early (e.g., on agent cancellation). */
  signal?: AbortSignal;
  /** Prefix all tool keys with `{toolPrefix}_` in the returned tools map. */
  toolPrefix?: string;
  /**
   * Post-processor for tool results — see {@link ScrubToolResult}. Set by
   * chat callers to lift oversized binary into a side store. Omit for
   * caller-agnostic / non-chat use.
   */
  scrubResult?: ScrubToolResult;
  /**
   * Workspace `.env` overlay. `auto`/`from_environment` entries in a server's
   * `env` / `startup.env` resolve from here before `process.env`.
   */
  envOverlay?: Record<string, string>;
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
        const resolvedEnv = config.env
          ? await resolveEnvValues(config.env, logger, options?.envOverlay)
          : {};
        const connected = await connectServerWithTimeout(
          config,
          resolvedEnv,
          serverId,
          logger,
          options?.envOverlay,
          signal,
        );
        const filtered = filterTools(connected.tools, config.tools);
        const prefixed = options?.toolPrefix
          ? prefixToolKeys(filtered, options.toolPrefix)
          : filtered;
        return { status: "success", serverId, client: connected.client, tools: prefixed };
      } catch (error) {
        if (
          error instanceof LinkCredentialNotFoundError ||
          error instanceof LinkCredentialExpiredError ||
          error instanceof LinkCredentialUnavailableError ||
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
        const cause = error instanceof Error && error.cause;
        const causeMessage =
          cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
        logger.warn("MCP server skipped due to connection error", {
          operation: "mcp_connect",
          serverId: value.serverId,
          error: message,
          cause: causeMessage,
        });
      }
      continue;
    }

    // status === "success"
    const wrappedTools = Object.fromEntries(
      Object.entries(value.tools).map(([name, tool]) => [
        name,
        wrapTool(tool, value.serverId, name, options?.scrubResult),
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
  error:
    | LinkCredentialNotFoundError
    | LinkCredentialExpiredError
    | LinkCredentialUnavailableError
    | NoDefaultCredentialError,
  serverId: string,
  config: MCPServerConfig,
): DisconnectedIntegration {
  // Message on every branch is the underlying error's `.message` verbatim —
  // Link's `error` field for refresh-failure cases, or the constructor-built
  // string for "not found" / "no default" cases that have no Link error
  // to forward. We never rewrite Link's actual error string.
  if (error instanceof LinkCredentialUnavailableError) {
    return {
      serverId,
      provider: extractProviderFromConfig(config),
      kind: "credential_temporarily_unavailable",
      message: error.message,
    };
  }
  if (error instanceof NoDefaultCredentialError) {
    return {
      serverId,
      provider: error.provider,
      kind: "no_default_credential",
      message: error.message,
    };
  }
  if (error instanceof LinkCredentialNotFoundError) {
    return {
      serverId,
      provider: extractProviderFromConfig(config),
      kind: "credential_not_found",
      message: error.message,
    };
  }
  return {
    serverId,
    provider: extractProviderFromConfig(config),
    kind:
      error.status === "expired_no_refresh" ? "credential_expired" : "credential_refresh_failed",
    message: error.message,
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
 *
 * Combines the optional external `signal` with an internal controller that
 * aborts when the timer fires, so the downstream abort listener in
 * `attemptStdio` kills the spawned child on both abort and timeout paths.
 *
 * AI SDK contract dependency: the "timer → SIGTERM" chain that closes #344
 * relies on `@ai-sdk/mcp`'s `StdioMCPTransport.close()` calling
 * `abortController.abort()` on the controller passed to Node's `spawn()` as
 * `signal` — which is how the child receives SIGTERM. This is internal AI
 * SDK behaviour and could regress silently on a version bump. The real
 * invariant ("subprocess PID is gone after abort/timeout") is verified by:
 *   - `packages/mcp/src/create-mcp-tools.subprocess-kill.test.ts`
 *   - `apps/atlasd/routes/mcp-registry.subprocess-kill.test.ts`
 * Both suites MUST pass before merging any `@ai-sdk/mcp` version bump.
 */
function connectServerWithTimeout(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
  envOverlay?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ConnectedServer> {
  const timeoutController = new AbortController();
  const downstreamSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  return withTimeout(
    connectServer(config, resolvedEnv, serverId, logger, envOverlay, downstreamSignal),
    LIST_TOOLS_TIMEOUT_MS,
    (actualDurationMs) => {
      const err = new MCPTimeoutError(
        serverId,
        "list_tools",
        LIST_TOOLS_TIMEOUT_MS,
        actualDurationMs,
      );
      timeoutController.abort(err);
      return err;
    },
    signal,
  );
}

/** Connect a single MCP server (stdio or HTTP). */
async function connectServer(
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
  envOverlay?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ConnectedServer> {
  const { transport } = config;
  switch (transport.type) {
    case "stdio":
      return await connectStdio(transport, resolvedEnv, serverId, logger, signal);
    case "http":
      return await connectHttp(config, resolvedEnv, serverId, logger, { envOverlay }, signal);
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

type StdioAttempt =
  | { ok: true; client: MCPClient; tools: Record<string, Tool> }
  | { ok: false; error: Error; stderr: string };

export async function attemptStdio(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<StdioAttempt> {
  if (signal?.aborted) throw signal.reason;

  // Pipe subprocess stderr through a temp file so we can read it on failure.
  // Two simpler approaches don't work reliably:
  //   - Passing an in-memory Writable: Deno's node:child_process compat
  //     silently falls back to "inherit", sending stderr to the parent.
  //   - Passing "pipe" and attaching a 'data' listener after createMCPClient
  //     resolves: by then a fast-exiting subprocess has already closed, and
  //     Deno's pipe drains buffered data on close — too late to recover it.
  // A real OS file descriptor sidesteps both: the kernel writes synchronously
  // and we can read after the subprocess dies.
  const tmpPath = path.join(tmpdir(), `mcp-stderr-${randomBytes(8).toString("hex")}.log`);
  const fd = openSync(tmpPath, "w+");
  let fdOpen = true;

  const readStderr = (): string => {
    const stats = fstatSync(fd);
    const size = Number(stats.size);
    if (size === 0) return "";
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8").trim();
  };

  // Hoist the transport so the abort listener can call transport.close()
  // BEFORE `createMCPClient` resolves. The AI SDK's createMCPClient awaits
  // the MCP `initialize` handshake with no signal observation — a server
  // that hangs at handshake (the exact #344 production failure) leaves
  // the spawn running with no termination path. transport.close() →
  // abortController.abort() → SIGTERM kills the child immediately and
  // the in-flight handshake rejects via the transport's onclose handler.
  const transport = new StdioMCPTransport({ command, args: [...args], env, stderr: fd });
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => {
      transport.close().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let client: MCPClient | undefined;
  try {
    try {
      client = await createMCPClient({ transport });
    } catch (err) {
      // The transport's start() can reject (e.g. ENOENT, or the subprocess
      // dies before completing the MCP handshake). Capture stderr from the
      // temp file and return failure rather than letting it propagate.
      // If the rejection is *because* the signal aborted (transport.close()
      // tore down the in-flight handshake), surface the abort reason instead
      // of the resulting "Connection closed" — preserves the contract that
      // an aborted attempt throws signal.reason.
      if (signal?.aborted) throw signal.reason;
      const stderr = readStderr();
      const error = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error, stderr };
    }

    // If the signal aborted in the narrow window between createMCPClient
    // resolving and reaching this check, the abort listener has already
    // called transport.close(). Surface signal.reason rather than
    // proceeding to client.tools() against a torn-down transport.
    if (signal?.aborted) {
      await client.close().catch(() => {});
      throw signal.reason;
    }

    // Verify the subprocess is actually responding AND capture tools in one call.
    // createMCPClient can succeed for stdio even when the server isn't ready yet.
    try {
      const tools = await client.tools();
      return { ok: true, client, tools };
    } catch (err) {
      await client.close().catch(() => {});
      const stderr = readStderr();
      const error = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error, stderr };
    }
  } finally {
    // Close the parent's fd in all cases — the subprocess (if still running)
    // has its own duped fd. Unlink the file to keep /tmp clean; on Unix the
    // subprocess can keep writing to the now-anonymous file, freed on exit.
    if (fdOpen) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      fdOpen = false;
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — file may not exist on Windows after close
    }
  }
}

/**
 * `uvx <pkg>` looks for an executable matching the package name. When the
 * registry entry's identifier differs from the package's entrypoint (e.g.
 * `bitbucket-mcp-py` vs `bitbucket-mcp`), uv refuses and prints the exact
 * recovery in its own error:
 *
 *   Use `uvx --from <pkg> <entrypoint>` instead.
 *
 * We parse that suggestion and re-attach the original version spec so the
 * pin is preserved. Returns null if the stderr doesn't match.
 */
function recoverUvxFromArgs(
  command: string,
  args: readonly string[],
  stderr: string,
): readonly string[] | null {
  if (command !== "uvx") return null;
  // User-authored configs may already be in the corrected `--from` form; if
  // uv still emits a hint in that case it's about something we can't fix by
  // rewriting args, so we leave the failure to surface as-is.
  if (args.includes("--from")) return null;
  // uv may emit ANSI color codes around the package name and entrypoint when
  // it thinks stderr is a terminal. Strip them before matching so the
  // captured tokens are clean argv values.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the intent
  const plain = stderr.replace(/\[[0-9;]*m/g, "");
  const match = /Use `uvx --from ([^\s`]+) ([^\s`]+)` instead\./.exec(plain);
  if (!match) return null;
  const suggestedPkg = match[1];
  const entrypoint = match[2];
  if (!suggestedPkg || !entrypoint) return null;
  // Find the original positional that carries the suggested package name —
  // a substring match preserves any version pin (`pkg==1.2.3` includes `pkg`)
  // and naturally skips value-taking flags like `--python 3.11` whose value
  // wouldn't contain the package name. Splice `--from <spec> <entry>` in
  // place of the package, keeping any uvx flags before it and any entrypoint
  // args after it. Fall back to appending if no positional matched.
  const pkgIdx = args.findIndex((a) => a.includes(suggestedPkg));
  if (pkgIdx >= 0) {
    return [
      ...args.slice(0, pkgIdx),
      "--from",
      args[pkgIdx]!,
      entrypoint,
      ...args.slice(pkgIdx + 1),
    ];
  }
  return [...args, "--from", suggestedPkg, entrypoint];
}

async function connectStdio(
  transport: Extract<MCPServerConfig["transport"], { type: "stdio" }>,
  resolvedEnv: Record<string, string>,
  serverId: string,
  logger: Logger,
  signal?: AbortSignal,
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

  let result = await attemptStdio(command, expandedArgs, mergedEnv, signal);
  let firstStderr: string | undefined;

  if (!result.ok) {
    const recoveryArgs = recoverUvxFromArgs(command, expandedArgs, result.stderr);
    if (recoveryArgs) {
      logger.warn(`MCP stdio retrying "${serverId}" with uvx --from form`, {
        operation: "mcp_connect_recover",
        serverId,
        command,
        originalArgs: expandedArgs,
        recoveryArgs,
        firstStderr: result.stderr || undefined,
      });
      // Hold the triggering stderr so it survives if the retry also fails —
      // otherwise the only diagnostic for the failure mode this code targets
      // would be lost in `result`'s reassignment below.
      firstStderr = result.stderr;
      result = await attemptStdio(command, recoveryArgs, mergedEnv, signal);
    }
  }

  if (!result.ok) {
    const combinedStderr =
      firstStderr && result.stderr !== firstStderr
        ? `first: ${firstStderr} | retry: ${result.stderr}`
        : result.stderr;
    logger.debug(`MCP stdio tools() failed for "${serverId}"`, {
      operation: "mcp_connect",
      serverId,
      error: result.error.message,
      stderrOutput: combinedStderr || undefined,
    });
    // Prepend subprocess stderr to the error message so callers see the
    // actual failure reason (e.g. "ENOENT: no such file or directory")
    // rather than just the generic "Connection closed" from the transport.
    if (combinedStderr) {
      result.error.message = `${combinedStderr} (${result.error.message})`;
    }
    throw result.error;
  }

  logger.debug(`MCP stdio connected for "${serverId}"`, { operation: "mcp_connect", serverId });

  return { client: result.client, tools: result.tools };
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
  deps: {
    spawn?: typeof defaultSpawn;
    fetch?: typeof fetch;
    pidFile?: PidFileWriter;
    /** Workspace `.env` overlay for resolving `startup.env` entries. */
    envOverlay?: Record<string, string>;
  } = {},
  signal?: AbortSignal,
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
    return connectHttpClient(url, headers, serverId, logger, signal);
  }

  // No startup config — try direct connection (will likely fail, matching old behaviour).
  if (!startup) {
    return connectHttpClient(url, headers, serverId, logger, signal);
  }

  // Resolve startup.env separately from config.env — bearer tokens must never
  // leak into the child process, and startup.env must never reach HTTP headers.
  const resolvedStartupEnv = startup.env
    ? await resolveEnvValues(startup.env, logger, deps.envOverlay)
    : {};

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
  // only. Deliberately not passing `signal` here: the shared subprocess
  // outlives any individual probe by design.
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

  return connectHttpClient(url, headers, serverId, logger, signal);
}

/** Create MCP client over HTTP transport and verify with tools(). */
async function connectHttpClient(
  url: string,
  headers: Record<string, string>,
  serverId: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<ConnectedServer> {
  if (signal?.aborted) throw signal.reason;

  logger.debug(`MCP HTTP connection attempt for "${serverId}"`, {
    operation: "mcp_connect",
    serverId,
    url,
  });

  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });

  const client = await createMCPClient({ transport: httpTransport });

  if (signal?.aborted) {
    await client.close().catch(() => {});
    throw signal.reason;
  }
  if (signal) {
    signal.addEventListener("abort", () => client.close().catch(() => {}), { once: true });
  }

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
