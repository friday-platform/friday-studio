/**
 * NATS server spawn helpers, shared between the daemon (which owns a
 * long-lived broker) and the CLI (which spawns ephemerally to run
 * migrations / scripts when no broker is reachable).
 *
 * The spawn primitive is pure: find the binary, write a server.conf
 * derived from `readJetStreamConfig()`, fork `nats-server -c <config>`,
 * poll TCP until ready, return a `{ proc, stop }` handle. Daemon-
 * specific orchestration (monitor-port warning, "already running"
 * detection chatter) stays in `apps/atlasd/src/nats-manager.ts` —
 * this module is the broker-side substrate.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { Logger } from "@atlas/logger";
import { readJetStreamConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_NATS_PORT = 4222;
export const DEFAULT_NATS_MONITOR_PORT = 8222;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

export interface SpawnedNats {
  /** PID of the spawned nats-server, or null on stop. */
  proc: ChildProcess | null;
  /** URL the spawned broker is reachable at. */
  url: string;
  /** Path to the generated server.conf. */
  configPath: string;
  /** SIGTERM the spawn and wait for exit. Idempotent. */
  stop(): Promise<void>;
}

export interface SpawnNatsOptions {
  /** TCP port to bind. Default 4222. */
  port?: number;
  /**
   * Where to write the generated config + spawn from. Defaults to
   * `<tmpdir>/friday-nats-<pid>/`. Daemons override with their own
   * persistent config dir under `getFridayHome()`.
   */
  workDir?: string;
  /**
   * Override the JetStream store directory. If unset, uses
   * `FRIDAY_JETSTREAM_STORE_DIR` env (via readJetStreamConfig), else
   * the daemon's home / jetstream path resolved by the caller.
   */
  storeDir: string;
  /** Optional logger; falls back to silent. */
  logger?: Pick<Logger, "info" | "warn">;
}

/** Find the nats-server binary in PATH or the friday-bundled location. */
export async function findNatsServerBinary(localBin?: string): Promise<string> {
  if (localBin) {
    try {
      await access(localBin);
      return localBin;
    } catch {
      // fall through
    }
  }
  try {
    const { stdout } = await execFileAsync("which", ["nats-server"]);
    return stdout.trim();
  } catch {
    throw new Error(
      "nats-server binary not found.\n" +
        "  Install with: brew install nats-server\n" +
        "  Or download from https://github.com/nats-io/nats-server/releases\n" +
        "  Or set FRIDAY_NATS_URL to point at an external nats-server.",
    );
  }
}

/** Write a server.conf derived from the env-driven JetStream config. */
export async function writeServerConfig(opts: {
  configPath: string;
  port: number;
  storeDir: string;
}): Promise<void> {
  const cfg = readJetStreamConfig();
  const lines = [
    `port: ${opts.port}`,
    "jetstream {",
    `  store_dir: "${opts.storeDir}"`,
    `  max_memory_store: ${cfg.server.maxMemoryStore.value}`,
    `  max_file_store: ${cfg.server.maxFileStore.value}`,
    "}",
    `max_payload: ${cfg.server.maxPayload.value}`,
    cfg.server.monitor.value ? `http_port: ${DEFAULT_NATS_MONITOR_PORT}` : "",
  ].filter(Boolean);
  await writeFile(opts.configPath, lines.join("\n"), "utf-8");
}

/** TCP probe — returns true if `host:port` accepts a connection within 500ms. */
export function tcpProbe(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
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

/**
 * Spawn nats-server. Returns once the TCP port responds. Caller must
 * `stop()` the handle (typically in a finally block) to clean up.
 *
 * Throws if the binary isn't found or the server fails to bind within
 * `READY_TIMEOUT_MS`. Spawn stderr is tailed and appended to the
 * thrown error message for diagnosable failures (port in use, unknown
 * config field, etc).
 */
export async function spawnNatsServer(opts: SpawnNatsOptions): Promise<SpawnedNats> {
  const port = opts.port ?? DEFAULT_NATS_PORT;
  const workDir = opts.workDir ?? join(tmpdir(), `friday-nats-${process.pid}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const configPath = join(workDir, "server.conf");

  await writeServerConfig({ configPath, port, storeDir: opts.storeDir });

  const binary = await findNatsServerBinary();

  const proc: ChildProcess = await new Promise((resolve, reject) => {
    const p = spawn(binary, ["-c", configPath], { stdio: "pipe" });
    let stderrTail = "";
    p.stderr?.on("data", (chunk: unknown) => {
      const s = typeof chunk === "string" ? chunk : String(chunk);
      stderrTail = (stderrTail + s).slice(-2000);
    });
    p.once("error", (err) => reject(new Error(`nats-server failed to start: ${err.message}`)));
    p.once("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `nats-server exited with code ${code}` +
              (stderrTail ? `\n--- nats-server stderr ---\n${stderrTail}` : ""),
          ),
        );
      }
    });
    // Give the spawn a beat to surface immediate exec errors, then hand off
    // to the TCP poll below.
    setTimeout(() => resolve(p), 50);
  });

  // Poll TCP until the port responds.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tcpProbe(port)) {
      const url = `nats://localhost:${port}`;
      opts.logger?.info?.("Spawned nats-server", { port, url, storeDir: opts.storeDir });
      return {
        proc,
        url,
        configPath,
        async stop() {
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          // Two-stage shutdown: SIGTERM, wait up to 3s for graceful exit
          // (nats-server flushes JetStream state on the way down), then
          // SIGKILL + wait again. The second stage catches the case where
          // a backlog of dirty pages outlasts SIGTERM's grace window —
          // without it the parent process exits with the child still
          // shutting down, leaving a zombie nats-server holding the
          // store_dir lock.
          const waitForExit = (ms: number): Promise<boolean> =>
            new Promise((resolve) => {
              if (proc.exitCode !== null || proc.signalCode !== null) {
                resolve(true);
                return;
              }
              const timer = setTimeout(() => resolve(false), ms);
              proc.once("exit", () => {
                clearTimeout(timer);
                resolve(true);
              });
            });

          proc.kill("SIGTERM");
          const cleanExit = await waitForExit(3_000);
          if (cleanExit) return;

          opts.logger?.warn?.("nats-server didn't exit on SIGTERM within 3s; sending SIGKILL");
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already gone between the check and the kill — fine.
          }
          await waitForExit(2_000);
        },
      };
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  proc.kill("SIGTERM");
  throw new Error(`nats-server did not become ready within ${READY_TIMEOUT_MS}ms`);
}
