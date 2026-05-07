/**
 * Tests for `NatsManager.stop(signal)` — specifically the abort+close
 * fallback that rescues shutdown when `nc.drain()` can't complete
 * (e.g. a JetStream pull-consumer mid-fetch holds the connection alive).
 *
 * The integration test in `daemon-shutdown.test.ts` only covers the clean
 * drain path. This file covers the rescue path that actually fired in the
 * 2026-05-07 incident: drain doesn't return, signal fires after the
 * per-step ceiling, `nc.close()` runs, event loop releases.
 *
 * Why a real broker (not a mock): the contract under test involves
 * NATS.js 2.29.x's drain/close semantics. A mock would let bugs in that
 * boundary slip through.
 */

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
    // Clean up in reverse-order of creation. Some tests deliberately kill
    // the server before calling stop(); guard each step against doubles.
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
        // already gone
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
    // Generous abort delay — drain completes well before this fires on
    // a healthy broker, so the abort listener never runs.
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

    // Kill the broker so drain() can't complete normally — this is the
    // shape of the 2026-05-07 incident, where a JetStream pull-consumer
    // mid-fetch made drain unable to confirm.
    await server.stop();
    server = undefined;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error("step ceiling")), 100);

    const started = Date.now();
    await mgr.stop(controller.signal);
    const elapsed = Date.now() - started;
    clearTimeout(t);

    // Without the close fallback, stop() would hang on the broken drain.
    // The 2000ms bound is comfortable above the 100ms abort + close cost
    // and catches a regression where the fallback wiring is removed.
    expect(elapsed).toBeLessThan(2000);
    expect(nc.isClosed()).toBe(true);
  }, 15_000);
});
