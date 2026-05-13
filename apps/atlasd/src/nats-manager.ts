import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import {
  brokerUrlFilePath,
  connectToNats,
  DEFAULT_NATS_MONITOR_PORT,
  deleteBrokerUrlFile,
  formatStartupLog,
  pickPort,
  readBrokerUrlFile,
  readJetStreamConfig,
  type SpawnedNats,
  spawnNatsServer,
  tcpProbe,
  writeBrokerUrlFile,
} from "jetstream";
import type { NatsConnection } from "nats";

/**
 * Daemon-side NATS lifecycle.
 *
 * Three modes, decided at start():
 *
 * - **External NATS** (`FRIDAY_NATS_URL` set): connect to that broker
 *   and never spawn. Cloud-with-shared-broker path; tenant isolation
 *   happens at the subject / NATS-account level.
 * - **URL file rendezvous**: read `<home>/nats/url` and TCP-probe it.
 *   If a broker is alive at that URL, reuse it. This is the
 *   in-process discovery channel for any sibling already running for
 *   this home (e.g. the launcher spawned `nats-server` before the
 *   daemon booted).
 * - **Spawn child**: solo-dev / launcher-fallback case. Pick a free
 *   port from the Friday-reserved range, spawn `nats-server`, write
 *   the URL to `<home>/nats/url` for siblings to discover.
 *
 * The actual spawn is delegated to `jetstream.spawnNatsServer`, which
 * is the same primitive the CLI uses for its ephemeral broker.
 */
export class NatsManager {
  private spawned: SpawnedNats | null = null;
  private nc: NatsConnection | null = null;
  /** Set when we own the URL file (i.e. we spawned the broker). */
  private ownsUrlFile = false;

  async start(): Promise<NatsConnection> {
    // Log resolved JetStream config + provenance unconditionally — applies
    // to spawn, URL-file reuse, and external-broker paths.
    const cfg = readJetStreamConfig();
    logger.info(formatStartupLog(cfg));

    const externalUrl = process.env.FRIDAY_NATS_URL;
    if (externalUrl) {
      logger.info("Using external NATS server", { url: externalUrl });
      this.nc = await connectToNats({ url: externalUrl, name: "atlasd" });
      logger.info("NATS connection established", { url: externalUrl });
      return this.nc;
    }

    const home = getFridayHome();
    const cachedUrl = await readBrokerUrlFile(home);
    if (cachedUrl) {
      const port = portFromUrl(cachedUrl);
      const live = port != null && (await tcpProbe(port));
      if (live) {
        logger.info("Discovered live broker via URL file; connecting without spawning", {
          url: cachedUrl,
          urlFile: brokerUrlFilePath(home),
        });
        this.nc = await connectToNats({ url: cachedUrl, name: "atlasd" });
        logger.info("NATS connection established", { url: cachedUrl });
        return this.nc;
      }
      logger.warn("Stale URL file detected; spawning fresh broker", {
        cachedUrl,
        urlFile: brokerUrlFilePath(home),
      });
    }

    const storeDir = cfg.server.storeDir.value ?? join(home, "nats");
    // Earlier daemon versions wrote JetStream data to nats-server's
    // built-in default location (`$TMPDIR/nats/jetstream`). Operators
    // upgrading past that change saw a fresh empty broker. Detect
    // orphaned data and tell them how to recover before they panic.
    await this.warnIfOrphanedJetStreamData(storeDir);

    const port = await pickPort();
    // Use the daemon's persistent config dir so re-launches reuse the
    // same generated server.conf (vs the spawn helper's default
    // tmpdir-based work dir, which is right for ephemeral CLI spawns
    // but throwaway for the daemon).
    this.spawned = await spawnNatsServer({ port, workDir: join(home, "nats"), storeDir, logger });

    const url = this.spawned.url;
    await writeBrokerUrlFile(home, url);
    this.ownsUrlFile = true;
    logger.info("Wrote broker URL file", { url, urlFile: brokerUrlFilePath(home) });

    if (process.env.FRIDAY_NATS_MONITOR === "1") {
      logger.info(`NATS monitoring enabled at http://localhost:${DEFAULT_NATS_MONITOR_PORT}`);
    }

    this.nc = await connectToNats({ url, name: "atlasd" });
    logger.info("NATS connection established", { url });
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

    if (this.ownsUrlFile) {
      await deleteBrokerUrlFile(getFridayHome());
      this.ownsUrlFile = false;
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
