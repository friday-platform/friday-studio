/**
 * Spawn an isolated nats-server with JetStream enabled per test suite.
 *
 * Each call grabs a free TCP port, writes JetStream's store to a temp dir,
 * and waits for the port to accept connections. `stop()` SIGTERMs the
 * process and removes the store dir.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestNatsServer {
  url: string;
  port: number;
  storeDir: string;
  stop(): Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not get free port")));
      }
    });
  });
}

function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host, port });
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`nats-server did not become ready on ${host}:${port}`));
        } else {
          setTimeout(tryOnce, 50);
        }
      });
    };
    tryOnce();
  });
}

export async function startNatsTestServer(): Promise<TestNatsServer> {
  const port = await findFreePort();
  const storeDir = mkdtempSync(join(tmpdir(), "atlas_nats_test_"));

  const proc: ChildProcess = spawn(
    "nats-server",
    ["--port", String(port), "--jetstream", "--store_dir", storeDir],
    { stdio: "ignore" },
  );

  proc.once("error", (err) => {
    throw new Error(`nats-server spawn failed: ${err.message}`);
  });

  await waitForTcp("127.0.0.1", port, 5000);

  return {
    url: `nats://127.0.0.1:${port}`,
    port,
    storeDir,
    async stop() {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      await rm(storeDir, { recursive: true, force: true });
    },
  };
}
