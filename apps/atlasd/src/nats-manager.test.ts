// Real broker (not a mock): the contract under test is NATS.js drain/close
// semantics — mocking that boundary would mask the bugs we care about.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NatsManager } from "./nats-manager.ts";

describe("NatsManager.stop(signal)", () => {
  let server: TestNatsServer | undefined;
  let mgr: NatsManager | undefined;
  let originalNatsUrl: string | undefined;

  beforeEach(() => {
    originalNatsUrl = process.env.FRIDAY_NATS_URL;
  });

  afterEach(async () => {
    if (mgr) {
      try {
        await mgr.stop();
      } catch {
        // best-effort
      }
      mgr = undefined;
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        // best-effort
      }
      server = undefined;
    }
    if (originalNatsUrl === undefined) {
      delete process.env.FRIDAY_NATS_URL;
    } else {
      process.env.FRIDAY_NATS_URL = originalNatsUrl;
    }
  });

  it("completes cleanly when drain succeeds before signal fires", async () => {
    server = await startNatsTestServer();
    process.env.FRIDAY_NATS_URL = server.url;
    mgr = new NatsManager();
    await mgr.start();
    const nc = mgr.connection;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5_000);

    await mgr.stop(controller.signal);
    clearTimeout(t);
    expect(nc.isClosed()).toBe(true);
  }, 15_000);

  it("falls back to nc.close() when drain hangs and signal aborts", async () => {
    server = await startNatsTestServer();
    process.env.FRIDAY_NATS_URL = server.url;
    mgr = new NatsManager();
    await mgr.start();
    const nc = mgr.connection;

    // Kill the broker so drain() hangs — forces the close() fallback path.
    await server.stop();
    server = undefined;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error("step ceiling")), 100);

    const started = Date.now();
    await mgr.stop(controller.signal);
    const elapsed = Date.now() - started;
    clearTimeout(t);

    // 2000ms = 100ms abort + close cost + CI slack; regresses if the
    // close() fallback is removed and stop() hangs on the broken drain.
    expect(elapsed).toBeLessThan(2000);
    expect(nc.isClosed()).toBe(true);
  }, 15_000);
});

describe("NatsManager — URL file is the rendezvous for out-of-env consumers", () => {
  let server: TestNatsServer | undefined;
  let mgr: NatsManager | undefined;
  let originalNatsUrl: string | undefined;
  let originalFridayHome: string | undefined;
  let home: string | undefined;

  beforeEach(async () => {
    originalNatsUrl = process.env.FRIDAY_NATS_URL;
    originalFridayHome = process.env.FRIDAY_HOME;
    home = await mkdtemp(join(tmpdir(), "nats-manager-url-file-test-"));
    process.env.FRIDAY_HOME = home;
  });

  afterEach(async () => {
    if (mgr) {
      try {
        await mgr.stop();
      } catch {
        // best-effort
      }
      mgr = undefined;
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        // best-effort
      }
      server = undefined;
    }
    if (home) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    if (originalNatsUrl === undefined) {
      delete process.env.FRIDAY_NATS_URL;
    } else {
      process.env.FRIDAY_NATS_URL = originalNatsUrl;
    }
    if (originalFridayHome === undefined) {
      delete process.env.FRIDAY_HOME;
    } else {
      process.env.FRIDAY_HOME = originalFridayHome;
    }
  });

  it("writes <home>/nats/url even when FRIDAY_NATS_URL is set (launcher-supervised path)", async () => {
    // The launcher-supervised production case: launcher pre-spawned
    // nats-server and pushed `FRIDAY_NATS_URL` into the daemon's env.
    // Without the URL-file write on this branch, a CLI in a separate
    // terminal — no inherited env — falls through to its own spawn
    // and crashes on the JetStream store-dir file lock.
    server = await startNatsTestServer();
    process.env.FRIDAY_NATS_URL = server.url;
    mgr = new NatsManager();
    await mgr.start();

    const urlFilePath = join(home as string, "nats", "url");
    const written = (await readFile(urlFilePath, "utf-8")).trim();
    expect(written).toBe(server.url);
  }, 15_000);

  it("deletes <home>/nats/url on stop()", async () => {
    server = await startNatsTestServer();
    process.env.FRIDAY_NATS_URL = server.url;
    mgr = new NatsManager();
    await mgr.start();

    const urlFilePath = join(home as string, "nats", "url");
    await stat(urlFilePath); // pre-condition: file exists

    await mgr.stop();
    mgr = undefined;

    await expect(stat(urlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
