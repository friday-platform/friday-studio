/**
 * NATS connection establishment, shared between the daemon and any other
 * process that needs to talk to the broker (CLI migrations, scripts, etc).
 *
 * This module deliberately does NOT spawn a nats-server. Spawning is the
 * daemon's responsibility — the CLI and scripts are clients that connect
 * to whatever broker is reachable. If no broker is up and `FRIDAY_NATS_URL`
 * isn't set, `connectToNats()` fails with an actionable error pointing
 * the operator at `atlas daemon start` (or external NATS).
 */

import process from "node:process";
import type { Logger } from "@atlas/logger";
import { connect, type NatsConnection } from "nats";
import {
  brokerUrlFilePath,
  pickPort,
  readBrokerUrlFile,
  type SpawnedNats,
  spawnNatsServer,
  tcpProbe,
} from "./spawn.ts";

export const DEFAULT_NATS_URL = "nats://localhost:4222";

export interface ConnectOptions {
  /**
   * Override URL. If unset, reads `FRIDAY_NATS_URL`, then falls back
   * to `DEFAULT_NATS_URL`.
   */
  url?: string;
  /**
   * Connection name surfaced in the broker's monitoring UI. Helps
   * distinguish "daemon" from "cli-migrate" from "script-foo" when
   * inspecting `nats server connections`.
   */
  name?: string;
  /** Connect timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Logger for connection events. */
  logger?: Logger;
}

/**
 * Resolve the NATS URL from explicit option → `FRIDAY_NATS_URL` env →
 * URL file at `<home>/nats/url` (when `home` is provided) → default
 * `DEFAULT_NATS_URL`. Exported so callers can log "where am I trying
 * to connect" before actually attempting the connection.
 *
 * Async because the URL-file lookup reads from disk.
 */
export async function resolveNatsUrl(opts: { url?: string; home?: string } = {}): Promise<string> {
  if (opts.url) return opts.url;
  const envUrl = process.env.FRIDAY_NATS_URL;
  if (envUrl) return envUrl;
  if (opts.home) {
    const fromFile = await readBrokerUrlFile(opts.home);
    if (fromFile) return fromFile;
  }
  return DEFAULT_NATS_URL;
}

/**
 * Open a NATS connection. Throws with a recovery hint if the broker
 * isn't reachable — most common failure mode for short-lived clients
 * (CLI commands, migration scripts) that don't manage broker lifecycle.
 *
 * Resolves the URL via `resolveNatsUrl` (explicit → env → URL file
 * when `home` is provided → default).
 */
export async function connectToNats(
  opts: ConnectOptions & { home?: string } = {},
): Promise<NatsConnection> {
  const url = await resolveNatsUrl(opts);
  const name = opts.name ?? "friday-client";
  try {
    return await connect({ servers: url, name, timeout: opts.timeoutMs ?? 5_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to NATS at ${url}: ${msg}\n` +
        `  - If the daemon is the broker owner, start it: \`atlas daemon start\`\n` +
        `  - If you're using external NATS, set FRIDAY_NATS_URL and ensure the broker is running\n` +
        `  - To verify: \`nats server check connection -s ${url}\``,
    );
  }
}

export interface ConnectionHandle {
  nc: NatsConnection;
  /**
   * Drain the connection and stop any broker we spawned. Idempotent.
   * Always call this in a `finally` — leaks an `nats-server` child
   * process otherwise when the CLI auto-spawned one.
   */
  cleanup(): Promise<void>;
}

export interface ConnectOrSpawnOptions extends ConnectOptions {
  /**
   * Override JetStream store directory passed to a spawned broker.
   * If unset, uses the daemon's home `<getFridayHome()>/jetstream` —
   * same path the daemon writes — so the spawn reads the same data
   * the daemon would have served.
   */
  storeDir?: string;
  /**
   * Home dir for URL-file discovery. When set, `connectOrSpawn`
   * first looks at `<home>/nats/url` and TCP-probes it before
   * trying the env-resolved URL. This is how CLI clients reach a
   * daemon-owned broker without guessing the port.
   */
  home?: string;
  /**
   * If true (default), and the connection fails AND we're in solo-dev
   * mode (no `FRIDAY_NATS_URL`), spawn an ephemeral `nats-server`.
   * The returned `cleanup()` stops it. Set false to disable the
   * fallback — useful when the caller wants a hard failure on no-broker.
   */
  spawnFallback?: boolean;
}

/**
 * Connect to NATS, spawning an ephemeral broker if needed.
 *
 * URL resolution (in order):
 *
 *   1. Explicit `opts.url`.
 *   2. `FRIDAY_NATS_URL` env (external broker; never spawn).
 *   3. `<home>/nats/url` file (when `opts.home` is provided and the
 *      file exists). The launcher / daemon writes this file when it
 *      spawns the broker. Stale entries are detected via TCP probe.
 *   4. Spawn an ephemeral broker (CLI fallback). The ephemeral broker
 *      uses a free port from the Friday-reserved range (`pickPort()`)
 *      and does NOT write to `<home>/nats/url` — that file is
 *      reserved for the long-lived daemon broker.
 *
 * `FRIDAY_NATS_URL` short-circuits the URL-file path so cloud
 * deployments connecting to a shared cluster never inadvertently
 * spawn local brokers.
 *
 * Spawn uses the same `readJetStreamConfig()` env vars and store_dir
 * as the daemon, so a CLI-spawned broker reads the same JetStream
 * data the daemon would have served. The store-dir file lock
 * prevents two brokers from opening the same store — the second
 * spawn fails fast with "store directory in use," which is the
 * correct behavior.
 */
export async function connectOrSpawn(opts: ConnectOrSpawnOptions = {}): Promise<ConnectionHandle> {
  const spawnFallback = opts.spawnFallback ?? true;

  // Resolve the URL in precedence order, tracking provenance. Provenance
  // matters because we only TCP-probe-and-reuse for URLs that came from
  // <home>/nats/url — a default-URL fallback must NOT reuse whatever
  // happens to be listening on :4222 (the silent-attach bug Phase 4
  // exists to close).
  const envUrl = process.env.FRIDAY_NATS_URL;
  let resolvedUrl: string;
  let source: "explicit" | "env" | "url-file" | "default";
  if (opts.url) {
    resolvedUrl = opts.url;
    source = "explicit";
  } else if (envUrl) {
    resolvedUrl = envUrl;
    source = "env";
  } else if (opts.home) {
    const fromFile = await readBrokerUrlFile(opts.home);
    if (fromFile) {
      resolvedUrl = fromFile;
      source = "url-file";
    } else {
      resolvedUrl = DEFAULT_NATS_URL;
      source = "default";
    }
  } else {
    resolvedUrl = DEFAULT_NATS_URL;
    source = "default";
  }

  if (source === "url-file") {
    // The home wrote this URL — trust it but probe to catch stale entries.
    const port = portFromUrl(resolvedUrl);
    const live = port != null && (await tcpProbe(port));
    if (live) {
      return openHandle(resolvedUrl, opts);
    }
    // Stale URL file: the daemon that wrote it crashed or shut down
    // without cleaning up. Fall through to spawn (CLI use case).
    opts.logger?.warn?.("URL file present but broker not responding; falling through to spawn", {
      cachedUrl: resolvedUrl,
      urlFile: brokerUrlFilePath(opts.home as string),
    });
  } else if (source !== "default") {
    // Explicit URL or env URL — try a direct connect.
    try {
      const nc = await connect({
        servers: resolvedUrl,
        name: opts.name ?? "friday-client",
        timeout: opts.timeoutMs ?? 5_000,
      });
      return {
        nc,
        cleanup: async () => {
          try {
            await nc.drain();
          } catch {
            // Already closed / draining.
          }
        },
      };
    } catch (err) {
      if (!spawnFallback) throw rethrowConnectError(resolvedUrl, err);
      if (source === "env") {
        // External-broker mode — refuse to spawn; the operator told us
        // explicitly where the broker lives.
        throw rethrowConnectError(resolvedUrl, err);
      }
      // Explicit URL with spawnFallback=true — fall through to spawn.
    }
  }
  // source === "default" falls straight through to spawn — we never
  // probe-and-reuse the legacy :4222 because that's the silent-attach
  // failure mode Phase 4 closes.

  // 3. Spawn an ephemeral broker (CLI fallback path).
  if (!opts.storeDir) {
    throw new Error(
      "connectOrSpawn requires `storeDir` to spawn a broker. " +
        "Caller must pass the same path the daemon would use " +
        "(typically `<getFridayHome()>/nats`).",
    );
  }

  opts.logger?.info?.("No broker reachable; spawning ephemeral nats-server");
  const port = await pickPort();
  let spawned: SpawnedNats;
  try {
    spawned = await spawnNatsServer({ port, storeDir: opts.storeDir, logger: opts.logger });
  } catch (spawnErr) {
    throw new Error(
      `Failed to spawn ephemeral nats-server: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}\n` +
        "  - Install with: brew install nats-server\n" +
        "  - Or start the daemon: `atlas daemon start`\n" +
        "  - Or set FRIDAY_NATS_URL to point at an external broker",
    );
  }

  const nc = await connect({
    servers: spawned.url,
    name: opts.name ?? "friday-client",
    timeout: opts.timeoutMs ?? 5_000,
  });

  return {
    nc,
    cleanup: async () => {
      try {
        await nc.drain();
      } catch {
        // Already closed
      }
      await spawned.stop();
    },
  };
}

/** Open a connection-only handle (no spawn, no cleanup of a child process). */
async function openHandle(url: string, opts: ConnectOptions): Promise<ConnectionHandle> {
  const nc = await connect({
    servers: url,
    name: opts.name ?? "friday-client",
    timeout: opts.timeoutMs ?? 5_000,
  });
  return {
    nc,
    cleanup: async () => {
      try {
        await nc.drain();
      } catch {
        // Already closed
      }
    },
  };
}

/** Extract the TCP port from a `nats://host:port` URL, or null if unparseable. */
function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function rethrowConnectError(url: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `Failed to connect to NATS at ${url}: ${msg}\n` +
      `  - If the daemon is the broker owner, start it: \`atlas daemon start\`\n` +
      `  - If you're using external NATS, set FRIDAY_NATS_URL and ensure the broker is running\n` +
      `  - To verify: \`nats server check connection -s ${url}\``,
  );
}
