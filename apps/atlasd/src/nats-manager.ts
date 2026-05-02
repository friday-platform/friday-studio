import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { connect, type NatsConnection } from "nats";

const NATS_PORT = 4222;
const NATS_MONITOR_PORT = 8222;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

const execFileAsync = promisify(execFile);

/**
 * NATS lifecycle:
 *
 * - **External NATS** (`FRIDAY_NATS_URL` set): the daemon connects to that
 *   broker and never spawns its own. Required for any deployment with more
 *   than one daemon process or for a managed-NATS topology.
 * - **Auto-detect existing**: if `nats://localhost:4222` is already serving
 *   (e.g. a dev `nats-server` started by hand), reuse it.
 * - **Spawn child**: solo-dev fallback — fork `nats-server --jetstream`
 *   and own its lifetime.
 *
 * The connection's URL list is the single source of truth for "where do I
 * speak NATS"; consumers never reach for `localhost:4222` directly.
 */
export class NatsManager {
  private proc: ChildProcess | null = null;
  private nc: NatsConnection | null = null;

  async start(): Promise<NatsConnection> {
    const externalUrl = process.env.FRIDAY_NATS_URL;
    if (externalUrl) {
      logger.info("Using external NATS server", { url: externalUrl });
      this.nc = await connect({ servers: externalUrl });
      logger.info("NATS connection established", { url: externalUrl });
      return this.nc;
    }

    const alreadyUp = await this.tcpProbe();
    if (alreadyUp) {
      logger.info("nats-server already running, connecting without spawning");
      // FRIDAY_NATS_MONITOR only takes effect when we spawn the server
      // ourselves. Probe the monitor endpoint and warn if the user expected
      // monitoring but the running server doesn't have it enabled.
      if (process.env.FRIDAY_NATS_MONITOR === "1") {
        const monitorUp = await this.tcpProbe(NATS_MONITOR_PORT);
        if (monitorUp) {
          logger.info(
            `NATS monitoring detected on existing server at http://localhost:${NATS_MONITOR_PORT}`,
          );
        } else {
          logger.warn(
            "FRIDAY_NATS_MONITOR=1 set but a nats-server was already running on " +
              `${NATS_PORT} without --http_port. Monitor flag ignored. Kill the ` +
              "existing nats-server (e.g. `pkill nats-server`) and restart the " +
              "daemon to enable monitoring.",
          );
        }
      }
    } else {
      const binary = await this.findBinary();
      await this.spawnServer(binary);
      await this.waitReady();
    }

    this.nc = await connect({ servers: `nats://localhost:${NATS_PORT}` });
    logger.info("NATS connection established", { port: NATS_PORT });
    return this.nc;
  }

  get connection(): NatsConnection {
    if (!this.nc) throw new Error("NatsManager not started — call start() first");
    return this.nc;
  }

  async stop(): Promise<void> {
    if (this.nc) {
      try {
        await this.nc.drain();
      } catch {
        // Ignore drain errors during shutdown
      }
      this.nc = null;
    }

    if (this.proc) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        this.proc!.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.proc = null;
    }
  }

  private async findBinary(): Promise<string> {
    // Prefer a binary pinned to ~/.friday/local/bin/ so the daemon is self-contained
    const localBin = join(getFridayHome(), "bin", "nats-server");
    try {
      await access(localBin);
      return localBin;
    } catch {
      // Not there — fall through to PATH
    }

    try {
      const { stdout } = await execFileAsync("which", ["nats-server"]);
      return stdout.trim();
    } catch {
      // Not in PATH either
    }

    throw new Error(
      "nats-server binary not found.\n" +
        "  Install with: brew install nats-server\n" +
        "  Or download from https://github.com/nats-io/nats-server/releases\n" +
        `  Or place the binary at ${localBin}\n` +
        "  Or set FRIDAY_NATS_URL to point at an external nats-server.",
    );
  }

  private spawnServer(binary: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ["--port", String(NATS_PORT), "--jetstream"];
      if (process.env.FRIDAY_NATS_MONITOR === "1") {
        args.push("--http_port", String(NATS_MONITOR_PORT));
        logger.info(`NATS monitoring enabled at http://localhost:${NATS_MONITOR_PORT}`);
      }
      this.proc = spawn(binary, args, { stdio: "pipe" });

      // Reject immediately on exec-level failures (binary not executable, etc.)
      this.proc.once("error", (err) =>
        reject(new Error(`nats-server failed to start: ${err.message}`)),
      );

      // If the process exits before we poll ready it almost certainly failed
      this.proc.once("exit", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`nats-server exited with code ${code}`));
        }
      });

      // Give the process a short tick to surface early exec errors, then hand
      // off to waitReady() for the TCP poll.
      setTimeout(resolve, 50);
    });
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.tcpProbe()) return;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    throw new Error(`nats-server did not become ready within ${READY_TIMEOUT_MS}ms`);
  }

  private tcpProbe(port: number = NATS_PORT): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }
}
