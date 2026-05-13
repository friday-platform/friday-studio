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
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectOrSpawn } from "./connect.ts";
import { brokerUrlFilePath, pickPort, spawnNatsServer } from "./spawn.ts";

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
    const broker = await spawnNatsServer({ port: await pickPort(), storeDir, logger: noopLogger });
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

  it("falls through to spawn when the URL file points at a dead broker", async () => {
    // Spawn + stop a broker, then write its now-dead URL to the file.
    // connectOrSpawn must detect the stale URL (TCP probe fails) and
    // spawn a fresh broker. spawnFallback defaults to true.
    const dead = await spawnNatsServer({ port: await pickPort(), storeDir, logger: noopLogger });
    const deadUrl = dead.url;
    await dead.stop();
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
    const dead = await spawnNatsServer({ port: await pickPort(), storeDir, logger: noopLogger });
    const deadUrl = dead.url;
    await dead.stop();
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
    // Picks a port nothing is listening on (high in the ephemeral
    // range). Direct connect fails; spawnFallback=false means no fallback.
    await expect(
      connectOrSpawn({
        url: "nats://127.0.0.1:65530",
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
    process.env.FRIDAY_NATS_URL = "nats://127.0.0.1:65531";
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
