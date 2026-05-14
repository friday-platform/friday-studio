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
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { Logger } from "@atlas/logger";
import { readJetStreamConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_NATS_PORT = 4222;
export const DEFAULT_NATS_MONITOR_PORT = 8222;

/**
 * Friday-reserved port range for per-home auto-allocation. Sits
 * alongside FRIDAY_PORT_FRIDAY=18080 / FRIDAY_PORT_LINK=13100 /
 * FRIDAY_PORT_PLAYGROUND=15200 in the 1XXXX band, outside both the
 * standard NATS port (4222) and the OS-ephemeral zone (49152+),
 * specifically to avoid colliding with unrelated tools binding
 * ephemeral ports.
 *
 * The Go launcher mirrors these constants at
 * `tools/friday-launcher/project.go` — keep in sync.
 */
const FRIDAY_NATS_PORT_BASE = 14222;
const FRIDAY_NATS_PORT_RANGE = 10;

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
    // Pin to loopback so `pickPort`'s `127.0.0.1` try-bind probe matches
    // the bind nats-server actually attempts. Without this nats-server
    // defaults to `0.0.0.0:<port>`, which overlaps with `127.0.0.1` and
    // can cause "already in use" failures when pickPort's loopback
    // check returned "free" microseconds earlier.
    'host: "127.0.0.1"',
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
 * Try to bind a TCP listener on `host:port`. Returns true if the bind
 * succeeded (port is free) and closes the listener immediately; false
 * if the kernel rejected (EADDRINUSE / EACCES / etc).
 */
function tryBind(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** Ask the kernel for any free port and return its number. */
function pickEphemeralPort(host: string = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not resolve ephemeral port")));
      }
    });
  });
}

/**
 * Pick a free port for a Friday NATS broker. Iterates the Friday-
 * reserved range first (`FRIDAY_NATS_PORT_BASE..+FRIDAY_NATS_PORT_RANGE-1`),
 * then falls back to an OS-assigned ephemeral port if all slots are
 * occupied. The reserved range avoids the kernel ephemeral zone so
 * Friday's broker doesn't squat on a port the user expected to be
 * available for unrelated services.
 *
 * Returns the port that was free at probe time. Tiny TOCTOU window
 * between probe and the subsequent `nats-server` bind — if a sibling
 * grabs the port in between, the broker spawn surfaces the failure
 * via stderr and the caller can retry.
 */
export async function pickPort(host: string = "127.0.0.1"): Promise<number> {
  for (let offset = 0; offset < FRIDAY_NATS_PORT_RANGE; offset++) {
    const port = FRIDAY_NATS_PORT_BASE + offset;
    if (await tryBind(port, host)) return port;
  }
  return pickEphemeralPort(host);
}

/**
 * Resolve the path to a home's broker URL file. Callers write this
 * after a successful spawn; consumers read it to discover the live
 * broker without guessing a port.
 */
export function brokerUrlFilePath(home: string): string {
  return join(home, "nats", "url");
}

/**
 * Write the broker URL atomically to `<home>/nats/url`. Tmp + rename
 * so partial writes never leave a malformed file. No trailing newline
 * to keep cross-language parsing trivial.
 */
export async function writeBrokerUrlFile(home: string, url: string): Promise<void> {
  const target = brokerUrlFilePath(home);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, url, "utf-8");
  await rename(tmp, target);
}

/**
 * Read the broker URL from `<home>/nats/url`, or null if the file
 * doesn't exist. Caller is responsible for probing liveness — a stale
 * file from a crashed daemon will still be readable.
 */
export async function readBrokerUrlFile(home: string): Promise<string | null> {
  try {
    return (await readFile(brokerUrlFilePath(home), "utf-8")).trim();
  } catch {
    return null;
  }
}

/**
 * Delete the broker URL file. Best-effort; missing file is fine. Call
 * on clean shutdown so the next spawner doesn't need to TCP-probe a
 * known-dead URL.
 */
export async function deleteBrokerUrlFile(home: string): Promise<void> {
  try {
    await unlink(brokerUrlFilePath(home));
  } catch {
    // ENOENT or other transient — fine.
  }
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
