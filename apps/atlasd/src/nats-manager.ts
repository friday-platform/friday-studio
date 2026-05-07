import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import {
  connectToNats,
  DEFAULT_NATS_MONITOR_PORT,
  DEFAULT_NATS_PORT,
  formatStartupLog,
  readJetStreamConfig,
  type SpawnedNats,
  spawnNatsServer,
  tcpProbe,
} from "jetstream";
import type { NatsConnection } from "nats";

/**
 * Daemon-side NATS lifecycle.
 *
 * Three modes, decided at start():
 *
 * - **External NATS** (`FRIDAY_NATS_URL` set): connect to that broker
 *   and never spawn. Required for any deployment with more than one
 *   daemon process or for a managed-NATS topology.
 * - **Auto-detect existing**: if `localhost:4222` is already serving
 *   (e.g. an `atlas migrate` run by the operator left a broker up,
 *   or someone started nats-server by hand), reuse it.
 * - **Spawn child**: solo-dev fallback — spawn `nats-server` and own
 *   its lifetime. Stop kills the child.
 *
 * The actual spawn is delegated to `jetstream.spawnNatsServer`, which
 * is the same primitive the CLI uses for its ephemeral broker.
 */
export class NatsManager {
  private spawned: SpawnedNats | null = null;
  private nc: NatsConnection | null = null;

  async start(): Promise<NatsConnection> {
    // Log resolved JetStream config + provenance unconditionally — applies
    // to spawn, reuse-existing-broker, and external-broker paths.
    const cfg = readJetStreamConfig();
    logger.info(formatStartupLog(cfg));

    const externalUrl = process.env.FRIDAY_NATS_URL;
    if (externalUrl) {
      logger.info("Using external NATS server", { url: externalUrl });
      this.nc = await connectToNats({ url: externalUrl, name: "atlasd" });
      logger.info("NATS connection established", { url: externalUrl });
      return this.nc;
    }

    const alreadyUp = await tcpProbe(DEFAULT_NATS_PORT);
    if (alreadyUp) {
      logger.info("nats-server already running, connecting without spawning");
      // FRIDAY_NATS_MONITOR only takes effect on the spawning process.
      // Probe the monitor endpoint and warn if the operator expected it
      // but the running broker doesn't have it enabled.
      if (process.env.FRIDAY_NATS_MONITOR === "1") {
        const monitorUp = await tcpProbe(DEFAULT_NATS_MONITOR_PORT);
        if (monitorUp) {
          logger.info(
            `NATS monitoring detected on existing server at http://localhost:${DEFAULT_NATS_MONITOR_PORT}`,
          );
        } else {
          logger.warn(
            "FRIDAY_NATS_MONITOR=1 set but a nats-server was already running on " +
              `${DEFAULT_NATS_PORT} without --http_port. Monitor flag ignored. Kill the ` +
              "existing nats-server (e.g. `pkill nats-server`) and restart the " +
              "daemon to enable monitoring.",
          );
        }
      }
    } else {
      const storeDir = cfg.server.storeDir.value ?? join(getFridayHome(), "nats");
      // Earlier daemon versions wrote JetStream data to nats-server's
      // built-in default location (`$TMPDIR/nats/jetstream`). Operators
      // upgrading past that change saw a fresh empty broker. Detect
      // orphaned data and tell them how to recover before they panic.
      await this.warnIfOrphanedJetStreamData(storeDir);

      // Use the daemon's persistent config dir so re-launches reuse the
      // same generated server.conf (vs the spawn helper's default
      // tmpdir-based work dir, which is right for ephemeral CLI spawns
      // but throwaway for the daemon).
      this.spawned = await spawnNatsServer({
        port: DEFAULT_NATS_PORT,
        workDir: join(getFridayHome(), "nats"),
        storeDir,
        logger,
      });
      if (process.env.FRIDAY_NATS_MONITOR === "1") {
        logger.info(`NATS monitoring enabled at http://localhost:${DEFAULT_NATS_MONITOR_PORT}`);
      }
    }

    this.nc = await connectToNats({ url: `nats://localhost:${DEFAULT_NATS_PORT}`, name: "atlasd" });
    logger.info("NATS connection established", { port: DEFAULT_NATS_PORT });
    return this.nc;
  }

  get connection(): NatsConnection {
    if (!this.nc) throw new Error("NatsManager not started — call start() first");
    return this.nc;
  }

  /**
   * Drain the NATS connection, then stop the spawned child if owned.
   *
   * The NATS client doesn't accept AbortSignal on drain/close, so when
   * `signal` fires before drain resolves we fall back to `nc.close()` to
   * release the event-loop handle. Without this, a JetStream pull-consumer
   * mid-fetch can keep the connection alive past the per-step ceiling and
   * block process exit.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    if (this.nc) {
      const nc = this.nc;
      const drainPromise = nc.drain().catch((err) => {
        logger.warn("NATS drain errored", { err: String(err) });
      });
      if (signal) {
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
        try {
          await Promise.race([drainPromise, aborted]);
        } catch {
          try {
            await nc.close();
          } catch (err) {
            logger.warn("NATS close errored", { err: String(err) });
          }
        }
      } else {
        await drainPromise;
      }
      this.nc = null;
    }

    if (this.spawned) {
      await this.spawned.stop();
      this.spawned = null;
    }
  }

  /**
   * If the new explicit store_dir is empty / fresh and the OS-tmpdir
   * default location has streams, log a recovery hint. We do not move
   * the data automatically — that's an operator decision (data may
   * span users / be owned by a different process / etc.) — but we make
   * the situation impossible to miss.
   */
  private async warnIfOrphanedJetStreamData(currentStoreDir: string): Promise<void> {
    const legacyCandidate = join(tmpdir(), "nats", "jetstream", "$G", "streams");
    let legacyEntries: string[] = [];
    try {
      legacyEntries = await readdir(legacyCandidate);
    } catch {
      return; // No legacy dir = nothing to recover.
    }
    if (legacyEntries.length === 0) return;

    let currentEntries: string[] = [];
    try {
      currentEntries = await readdir(join(currentStoreDir, "jetstream", "$G", "streams"));
    } catch {
      // Current dir doesn't exist yet — broker hasn't booted with new path.
    }
    if (currentEntries.length > 0) return; // Already migrated or already populated.

    // nats-server appends `/jetstream/$G/streams` under its configured
    // store_dir. Legacy default was `$TMPDIR/nats` (broker creates
    // `$TMPDIR/nats/jetstream/$G/...`); current default is
    // `<fridayHome>/nats` (broker creates `<fridayHome>/nats/jetstream
    // /$G/...`). Same one-level shape on both sides — the recover
    // command rsyncs the JetStream root verbatim.
    const legacyRoot = join(tmpdir(), "nats", "jetstream");
    const newRoot = join(currentStoreDir, "jetstream");
    logger.warn(
      [
        "",
        "════════════════════════════════════════════════════════════════════",
        "ORPHANED JETSTREAM DATA DETECTED",
        "════════════════════════════════════════════════════════════════════",
        `Earlier daemon versions wrote JetStream data to nats-server's`,
        `default store directory: ${legacyCandidate}`,
        "",
        `That directory holds ${legacyEntries.length} streams.`,
        `The current daemon is configured to use: ${currentStoreDir}`,
        "— which is empty.",
        "",
        "Your chats, memory, and signals are NOT lost — they're sitting at",
        `the legacy path. Recover with (daemon stopped):`,
        "",
        `  mkdir -p "${newRoot}"`,
        `  rsync -a "${legacyRoot}/" "${newRoot}/"`,
        "",
        "Then restart the daemon. To suppress this warning without moving",
        "data, set FRIDAY_JETSTREAM_STORE_DIR to the legacy path.",
        "════════════════════════════════════════════════════════════════════",
        "",
      ].join("\n"),
    );
  }
}
