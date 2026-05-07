// Real broker (not a mock): the contract under test is NATS.js drain/close
// semantics — mocking that boundary would mask the bugs we care about.

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
      } catch {}
      mgr = undefined;
    }
    if (server) {
      try {
        await server.stop();
      } catch {}
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
