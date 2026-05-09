/**
 * G4 — elicitations sweeper.
 *
 * Verifies the daemon-side wrapper around
 * `ElicitationStorage.expirePending`. The adapter-level behavioral
 * coverage (CAS, idempotence, read-time derivation) lives in
 * `packages/core/src/elicitations/jetstream-adapter.test.ts`; this
 * suite asserts the timer-loop wrapper:
 *
 *   1) `tick()` invokes the storage facade and surfaces its result.
 *   2) `stop()` is idempotent and clears the timer.
 *   3) Past-deadline pending entries flip to `expired` end-to-end
 *      through the facade (not just the in-memory adapter).
 *
 * The vitest setup wires `ElicitationStorage` against a per-worker
 * NATS test server, so the sweeper exercises real storage end-to-end.
 */

import { ElicitationStorage, initElicitationStorage } from "@atlas/core/elicitations";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestNc } from "../../../../vitest.setup.ts";
import { startElicitationsSweeper } from "./elicitations-sweeper.ts";

beforeAll(() => {
  // The vitest setup initializes the other storage facades but not
  // elicitations — wire it up here so the sweeper's facade-backed
  // call path resolves.
  initElicitationStorage(getTestNc());
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expiresIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("elicitations sweeper", () => {
  it("flips a past-deadline pending entry to expired on tick()", async () => {
    const workspaceId = `ws-sw-${crypto.randomUUID()}`;
    // Tight deadline — past by the time the sweeper runs.
    const created = await ElicitationStorage.create({
      workspaceId,
      sessionId: `ses-${crypto.randomUUID()}`,
      kind: "open-question",
      question: "Are you still there?",
      expiresAt: expiresIn(100),
    });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);

    // Inject a fake "now" past the entry's deadline so we don't have
    // to sleep. The interval value is irrelevant — we call tick()
    // directly.
    const fakeNow = new Date(Date.parse(created.data.expiresAt) + 60_000);
    const sweeper = startElicitationsSweeper({ intervalMs: 60_000, now: () => fakeNow });
    try {
      const out = await sweeper.tick();
      expect(out.expired).toContain(created.data.id);
      expect(out.errors).toBe(0);
    } finally {
      sweeper.stop();
    }

    const got = await ElicitationStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data?.status).toBe("expired");
  });

  it("leaves not-yet-expired pending entries alone", async () => {
    const workspaceId = `ws-sw-future-${crypto.randomUUID()}`;
    const created = await ElicitationStorage.create({
      workspaceId,
      sessionId: `ses-${crypto.randomUUID()}`,
      kind: "open-question",
      question: "Future deadline",
      expiresAt: expiresIn(60 * 60 * 1000), // 1h ahead
    });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);

    // Fake "now" still before the deadline.
    const sweeper = startElicitationsSweeper({ intervalMs: 60_000, now: () => new Date() });
    try {
      const out = await sweeper.tick();
      expect(out.expired).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    // Read with an in-window now — derivation is a no-op so we see
    // the persisted `pending` state. (A read past the deadline would
    // surface `expired` via the read-time derivation in the adapter.)
    const got = await ElicitationStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data?.status).toBe("pending");
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    const sweeper = startElicitationsSweeper({ intervalMs: 60_000 });
    sweeper.stop();
    expect(() => sweeper.stop()).not.toThrow();
  });
});
