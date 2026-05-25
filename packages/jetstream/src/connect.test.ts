/**
 * Tests for `connectOrSpawn`'s URL-file rendezvous path.
 *
 * Phase 4's contract: when `home` is set, the broker URL lives at
 * `<home>/nats/url`. Consumers (daemon, CLI, future tooling) discover
 * the broker through that file rather than guessing the port. Stale
 * URL files (daemon crashed without cleanup) are detected via TCP
 * probe and treated as "no broker — spawn fresh."
 *
 * The single chokepoint these tests pin is `spawnFallback`: it must
 * be honored on EVERY no-connect path, not just the explicit-URL
 * branch. A prior refactor regressed this by moving the check into
 * one source branch; these tests catch that class of bug.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectOrSpawn } from "./connect.ts";
import { brokerUrlFilePath, spawnNatsServer } from "./spawn.ts";

/**
 * OS-assigned free port via `listen(0)`. Drawn from the kernel's
 * ephemeral range — NOT the 10-slot Friday-reserved range used by
 * `pickPort` in spawn.ts. The reserved range is concurrently claimed
 * by the CI workflow's pre-launched daemon, daemon-startup tests, and
 * nats-manager tests; using it here led to a flake where a just-stopped
 * broker's port was probed against a sibling worker's half-spawned
 * nats-server (or its own half-torn listening socket).
 *
 * Tiny TOCTOU window between close and the caller's bind — fine for
 * both "spawn a broker here" (spawnNatsServer surfaces the conflict)
 * and "assert nothing is listening here" patterns.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not resolve free port")));
      }
    });
  });
}

/** Local copy of spawn.ts's private `tryBind` — used by waitUntilBindable. */
function tryBind(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * Spin until `port` is re-bindable. After `dead.stop()` the kernel can
 * leave the listening socket half-torn for a few ms; tcpProbe() against
 * it falsely reports "alive" and connectOrSpawn takes the reuse branch,
 * then the real NATS handshake fails with CONNECTION_REFUSED. Waiting
 * for tryBind to succeed before the test continues closes that window.
 */
async function waitUntilBindable(
  port: number,
  host: string = "127.0.0.1",
  timeoutMs: number = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryBind(port, host)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`port ${port} did not become bindable within ${timeoutMs}ms`);
}

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

let home: string;
let storeDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "friday-connect-test-"));
  storeDir = join(home, "nats");
  await mkdir(storeDir, { recursive: true });
  // The connectOrSpawn external-broker branch reads FRIDAY_NATS_URL from
  // process.env. Clear it to avoid interference from the developer's
  // shell environment.
  delete process.env.FRIDAY_NATS_URL;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("connectOrSpawn — URL-file rendezvous (source: url-file)", () => {
  it("reuses a live broker advertised by the URL file", async () => {
    // Spawn a real broker on a free port, write its URL to <home>/nats/url
    // as if a sibling daemon had done so. connectOrSpawn must reuse it
    // (no second spawn against the same store dir — that would file-lock
    // conflict).
    const broker = await spawnNatsServer({
      port: await pickFreePort(),
      storeDir,
      logger: noopLogger,
    });
    try {
      await writeFile(brokerUrlFilePath(home), broker.url, "utf-8");

      const handle = await connectOrSpawn({ home, storeDir, logger: noopLogger });
      try {
        // Real connection — drain works only against a live broker.
        await handle.nc.flush();
        expect(handle.nc.isClosed()).toBe(false);
      } finally {
        await handle.cleanup();
      }
    } finally {
      await broker.stop();
    }
  });

  // Timeout: two nats-server spawns + a stop with up to 3s SIGTERM grace
  // can exceed vitest's 5s default on cold CI runners. Sequence:
  // spawn (~2s) → stop (~3s) → tcpProbe (500ms) → fresh spawn (~2s).
  it("falls through to spawn when the URL file points at a dead broker", {
    timeout: 20_000,
  }, async () => {
    // Spawn + stop a broker, then write its now-dead URL to the file.
    // connectOrSpawn must detect the stale URL (TCP probe fails) and
    // spawn a fresh broker. spawnFallback defaults to true.
    const port = await pickFreePort();
    const dead = await spawnNatsServer({ port, storeDir, logger: noopLogger });
    const deadUrl = dead.url;
    await dead.stop();
    // Confirm the kernel has fully released the listening socket before
    // we hand the URL to connectOrSpawn — otherwise its tcpProbe can
    // race the teardown and falsely conclude the broker is still alive.
    await waitUntilBindable(port);
    await writeFile(brokerUrlFilePath(home), deadUrl, "utf-8");

    const handle = await connectOrSpawn({ home, storeDir, logger: noopLogger });
    try {
      // connectOrSpawn spawned a fresh broker — flush proves the
      // connection is alive. We deliberately don't assert the new
      // port differs from the dead one: pickPort can legitimately
      // re-pick the same port if it's free again, and "alive" is
      // the contract that matters.
      await handle.nc.flush();
      expect(handle.nc.isClosed()).toBe(false);
    } finally {
      await handle.cleanup();
    }
  });
});

describe("connectOrSpawn — spawnFallback=false honors the no-spawn contract", () => {
  it("throws when URL file is stale and spawnFallback=false", async () => {
    // The bug the prior review caught: stale URL file → previously
    // would silently spawn even with spawnFallback=false because the
    // source-tracking refactor moved the spawnFallback check into one
    // source branch.
    const port = await pickFreePort();
    const dead = await spawnNatsServer({ port, storeDir, logger: noopLogger });
    const deadUrl = dead.url;
    await dead.stop();
    await waitUntilBindable(port);
    await writeFile(brokerUrlFilePath(home), deadUrl, "utf-8");

    await expect(
      connectOrSpawn({ home, storeDir, spawnFallback: false, logger: noopLogger }),
    ).rejects.toThrow(/spawnFallback=false/);
  });

  it("throws when no URL is resolvable and spawnFallback=false", async () => {
    // No opts.url, no FRIDAY_NATS_URL, no URL file under `home`. Without
    // the spawn gate, the legacy code would spawn an ephemeral broker
    // here. With it, the call throws.
    await expect(
      connectOrSpawn({ home, storeDir, spawnFallback: false, logger: noopLogger }),
    ).rejects.toThrow(/spawnFallback=false/);
  });

  it("throws when explicit URL fails to connect and spawnFallback=false", async () => {
    // Direct connect fails; spawnFallback=false means no fallback. The
    // port comes from pickFreePort() so we know nothing else can have
    // been assigned to it by the kernel in parallel.
    const deadPort = await pickFreePort();
    await expect(
      connectOrSpawn({
        url: `nats://127.0.0.1:${deadPort}`,
        storeDir,
        spawnFallback: false,
        timeoutMs: 200,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/Failed to connect/);
  });

  it("throws on env URL connect failure regardless of spawnFallback", async () => {
    // FRIDAY_NATS_URL is the operator's explicit declaration of an
    // external broker. If it fails, spawning silently would shadow the
    // operator's intent — throw even with spawnFallback=true.
    const deadPort = await pickFreePort();
    process.env.FRIDAY_NATS_URL = `nats://127.0.0.1:${deadPort}`;
    try {
      await expect(
        connectOrSpawn({ storeDir, timeoutMs: 200, logger: noopLogger }),
      ).rejects.toThrow(/Failed to connect/);
    } finally {
      delete process.env.FRIDAY_NATS_URL;
    }
  });
});

describe("connectOrSpawn — source: none (no URL anywhere, spawnFallback=true)", () => {
  it("spawns an ephemeral broker when no URL is resolvable", async () => {
    // No opts.url, no FRIDAY_NATS_URL, no URL file. With spawnFallback
    // defaulting to true, the call should spawn ephemerally and return
    // a working connection. Critically, it must NOT probe `:4222` and
    // reuse whatever's there — that was the silent-attach bug.
    const handle = await connectOrSpawn({ home, storeDir, logger: noopLogger });
    try {
      await handle.nc.flush();
      expect(handle.nc.isClosed()).toBe(false);
    } finally {
      await handle.cleanup();
    }
  });
});
