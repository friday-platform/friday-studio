/**
 * Integration test for the `/api/daemon/shutdown` HTTP route.
 *
 * Verifies the tracer-bullet contract from task #13:
 * - POST `/api/daemon/shutdown` responds 200 immediately.
 * - The daemon process exits with code 0 within 12s on the clean path.
 * - The 15s watchdog does NOT fire (proves natural exit won the race).
 * - The clean-path exit log marker IS emitted (proves we exited via the
 *   `daemon.shutdown()` resolve path, not some other route).
 *
 * Why a subprocess: the route's contract is `Deno.exit(0)`. An in-process
 * test would tear down vitest itself. The shim at
 * `apps/atlasd/test-fixtures/daemon-test-entry.ts` is the minimum bringup
 * needed for this to be honest — no CLI/yargs/OTEL flake surface.
 *
 * Why Node `child_process.spawn` (not `Deno.Command`): vitest runs under
 * Node, so `Deno` is undefined in this file's scope. The spawned shim
 * itself runs under Deno.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const SENTINEL_DEADLINE_MS = 25_000;
const EXIT_DEADLINE_MS = 12_000;

const SENTINEL_FRAGMENT = "Atlas daemon running";
const CLEAN_EXIT_MARKER = "Shutdown complete, exiting";
const WATCHDOG_MARKER = "Shutdown watchdog fired";

const DENO_FLAGS = [
  "run",
  "--allow-all",
  "--unstable-kv",
  "--unstable-broadcast-channel",
  "--unstable-worker-options",
  "--unstable-raw-imports",
] as const;

const ENTRY_SCRIPT = "apps/atlasd/test-fixtures/daemon-test-entry.ts";

interface SpawnedDaemon {
  child: ChildProcess;
  port: number;
  /** Resolves when the child exits with the exit code (or null on signal). */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Concatenated stdout text once the child has exited. */
  stdoutDone: Promise<string>;
  /** Concatenated stderr text once the child has exited. */
  stderrDone: Promise<string>;
}

/**
 * Race a promise against a timeout. Rejects with a contextual error on
 * timeout so failures point at *which* phase hung, not just "timeout".
 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Drain a Node `Readable` to a UTF-8 string while invoking `onLine` for
 * each newline-terminated chunk seen. Buffer is flushed at stream end to
 * surface any trailing partial line.
 */
function drainReadable(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let collected = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      collected += chunk;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) onLine(buffer);
      resolve(collected);
    });
    stream.on("error", reject);
  });
}

/**
 * Extract the bound port from a sentinel log line. The logger writes
 * structured JSON; we look for the first `"port":<n>` or `port: <n>`
 * occurrence to stay tolerant of the exact serialization shape.
 */
function parsePortFromSentinel(line: string): number | undefined {
  const match = line.match(/"port"\s*:\s*(\d+)|port:\s*(\d+)/);
  if (!match) return undefined;
  const raw = match[1] ?? match[2];
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Spawn the daemon test shim and wait for the "Atlas daemon running"
 * sentinel. Returns handles for the child, its discovered port, and
 * promises for full stdout/stderr capture.
 */
async function spawnDaemonAndWaitForSentinel(): Promise<SpawnedDaemon> {
  // Strip OTEL/auth env so the shim doesn't trigger telemetry exporters
  // or the cypher token fetch. Deno rejects `OTEL_DENO=` with a warning
  // (only "true"/"false" are accepted), so we must DELETE the keys, not
  // blank them.
  //
  // CRITICAL: also delete `DENO_TESTING`. The vitest runner sets it (see
  // `deno.json` `tasks.test`), and `@atlas/logger` short-circuits all log
  // output when it's `"true"`. Without this delete, the spawned daemon
  // never emits the readiness sentinel and this test hangs.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  childEnv.ANTHROPIC_API_KEY = "test-key";
  delete childEnv.OTEL_DENO;
  delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete childEnv.OTEL_EXPORTER_OTLP_HEADERS;
  delete childEnv.OTEL_RESOURCE_ATTRIBUTES;
  delete childEnv.FRIDAY_KEY;
  delete childEnv.CYPHER_TOKEN_URL;
  delete childEnv.DENO_TESTING;

  const child = spawn("deno", [...DENO_FLAGS, ENTRY_SCRIPT], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.stdout || !child.stderr) {
    throw new Error("spawned daemon missing stdout/stderr");
  }

  let portResolve: (port: number) => void;
  let portReject: (err: Error) => void;
  const portPromise = new Promise<number>((resolve, reject) => {
    portResolve = resolve;
    portReject = reject;
  });
  let resolved = false;

  const stdoutDone = drainReadable(child.stdout, (line) => {
    if (!resolved && line.includes(SENTINEL_FRAGMENT)) {
      const port = parsePortFromSentinel(line);
      if (port !== undefined) {
        resolved = true;
        portResolve(port);
      }
    }
  });

  // Drain stderr so the child doesn't block on a full pipe buffer, and so
  // we can later assert on shutdown markers.
  const stderrDone = drainReadable(child.stderr, () => {});

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // If the child exits before sentinel, surface that as a clear failure.
  exit.then((s) => {
    if (!resolved) {
      portReject(new Error(`daemon exited before sentinel (code=${s.code} signal=${s.signal})`));
    }
  });

  child.once("error", (err) => {
    if (!resolved) portReject(err);
  });

  const port = await withDeadline(portPromise, SENTINEL_DEADLINE_MS, "sentinel wait");

  return { child, port, exit, stdoutDone, stderrDone };
}

describe("daemon /shutdown route", () => {
  let spawned: SpawnedDaemon | undefined;

  afterEach(async () => {
    // Defensive: if a test bailed before the daemon exited, kill it so the
    // suite doesn't leak processes.
    if (spawned) {
      try {
        spawned.child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      // Drain so the pipes close and we don't leak file descriptors.
      await Promise.allSettled([spawned.exit, spawned.stdoutDone, spawned.stderrDone]);
      spawned = undefined;
    }
  });

  // Hard backstop in case afterEach somehow misses (e.g. spawn failed).
  afterAll(() => {
    if (spawned) {
      try {
        spawned.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  });

  it(
    "exits with code 0 within 12s on POST /shutdown without firing the watchdog",
    async () => {
      spawned = await spawnDaemonAndWaitForSentinel();

      const response = await fetch(`http://127.0.0.1:${spawned.port}/api/daemon/shutdown`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ message: "Daemon shutdown initiated" });

      const exitStatus = await withDeadline(spawned.exit, EXIT_DEADLINE_MS, "daemon exit wait");
      expect(exitStatus.code).toBe(0);
      expect(exitStatus.signal).toBeNull();

      // Streams close on child exit; gather the captured output.
      const [stdoutText, stderrText] = await Promise.all([
        spawned.stdoutDone,
        spawned.stderrDone,
      ]);
      const allOutput = `${stdoutText}\n${stderrText}`;

      // Two-sided check: clean-path log present, watchdog log absent.
      expect(allOutput).toContain(CLEAN_EXIT_MARKER);
      expect(allOutput).not.toContain(WATCHDOG_MARKER);

      spawned = undefined;
    },
    TEST_TIMEOUT_MS,
  );
});
