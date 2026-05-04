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
import { DEFAULT_NATS_PORT, type SpawnedNats, spawnNatsServer, tcpProbe } from "./spawn.ts";

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
 * Resolve the NATS URL from explicit option → env → default. Exported
 * so callers can log "where am I trying to connect" before actually
 * attempting the connection.
 */
export function resolveNatsUrl(opts: { url?: string } = {}): string {
  return opts.url ?? process.env.FRIDAY_NATS_URL ?? DEFAULT_NATS_URL;
}

/**
 * Open a NATS connection. Throws with a recovery hint if the broker
 * isn't reachable — most common failure mode for short-lived clients
 * (CLI commands, migration scripts) that don't manage broker lifecycle.
 */
export async function connectToNats(opts: ConnectOptions = {}): Promise<NatsConnection> {
  const url = resolveNatsUrl(opts);
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
 * Three cases the function handles, in order:
 *
 *   1. **Connection succeeds.** Existing broker (daemon-owned, external,
 *      or someone else's process). Returns `{ nc, cleanup }` where
 *      cleanup just drains `nc`.
 *   2. **Connection refused, `FRIDAY_NATS_URL` is set.** The operator
 *      declared an external broker; spawning would silently shadow it.
 *      Throw the original connection error with the recovery hint.
 *   3. **Connection refused, solo-dev mode.** Spawn `nats-server` with
 *      the daemon's store_dir, connect to it, return `{ nc, cleanup }`
 *      where cleanup drains the connection AND kills the spawn.
 *
 * The spawn uses the same `readJetStreamConfig()` env vars and the
 * same default store_dir as the daemon, so a CLI-spawned broker reads
 * the same JetStream data the daemon would have served. Single-writer
 * lock on the store_dir prevents the rare race where the daemon comes
 * up while the CLI is mid-migration — second spawn fails fast with
 * "store directory in use," which is the correct behavior.
 */
export async function connectOrSpawn(opts: ConnectOrSpawnOptions = {}): Promise<ConnectionHandle> {
  const url = resolveNatsUrl(opts);
  const spawnFallback = opts.spawnFallback ?? true;

  // 1. Try the existing broker first.
  try {
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
          // Already closed / draining.
        }
      },
    };
  } catch (err) {
    if (!spawnFallback) throw rethrowConnectError(url, err);
    if (process.env.FRIDAY_NATS_URL) {
      // 2. External-broker mode — refuse to spawn; surface the error.
      throw rethrowConnectError(url, err);
    }
  }

  // 3. Solo-dev fallback: spawn ephemerally.
  if (!opts.storeDir) {
    throw new Error(
      "connectOrSpawn requires `storeDir` to spawn a broker. " +
        "Caller must pass the same path the daemon would use " +
        "(typically `<getFridayHome()>/jetstream`).",
    );
  }

  // Verify nothing's listening between our connect attempt and the
  // spawn — a daemon could have come up in the gap, in which case
  // re-connecting is correct.
  if (await tcpProbe(DEFAULT_NATS_PORT)) {
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
          // ignore
        }
      },
    };
  }

  opts.logger?.info?.("No broker reachable; spawning ephemeral nats-server");
  let spawned: SpawnedNats;
  try {
    spawned = await spawnNatsServer({ storeDir: opts.storeDir, logger: opts.logger });
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

function rethrowConnectError(url: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `Failed to connect to NATS at ${url}: ${msg}\n` +
      `  - If the daemon is the broker owner, start it: \`atlas daemon start\`\n` +
      `  - If you're using external NATS, set FRIDAY_NATS_URL and ensure the broker is running\n` +
      `  - To verify: \`nats server check connection -s ${url}\``,
  );
}
