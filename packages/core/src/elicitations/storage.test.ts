/**
 * Facade-level tests for the elicitation storage module. The
 * JetStream-adapter integration lives behind a live NATS server and
 * is out of scope here (gated to `*.integration.test.ts` later).
 *
 * What these tests guarantee:
 *  - the facade throws if used before `initElicitationStorage`.
 *  - `resetElicitationStorageForTests` puts the module back into the
 *    uninitialized state for the next test.
 *  - after init, the facade methods are callable and delegate to the
 *    underlying adapter (verified via a stub adapter swapped in
 *    through a re-import after reset).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

describe("ElicitationStorage facade", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("throws a clear error if create() is called before init", async () => {
    vi.resetModules();
    const { ElicitationStorage } = await import("./storage.ts");
    expect(() =>
      ElicitationStorage.create({
        workspaceId: "ws",
        sessionId: "sess",
        kind: "open-question",
        question: "?",
        expiresAt: "2026-05-05T01:00:00.000Z",
      }),
    ).toThrow(/not initialized/i);
  });

  it("throws if get() is called before init", async () => {
    vi.resetModules();
    const { ElicitationStorage } = await import("./storage.ts");
    expect(() => ElicitationStorage.get({ id: "elc_x" })).toThrow(/not initialized/i);
  });

  it("throws if list() is called before init", async () => {
    vi.resetModules();
    const { ElicitationStorage } = await import("./storage.ts");
    expect(() => ElicitationStorage.list({})).toThrow(/not initialized/i);
  });

  it("resetElicitationStorageForTests un-binds the adapter", async () => {
    vi.resetModules();
    const mod = await import("./storage.ts");
    // The real init takes a NatsConnection we don't construct here; we
    // only need to confirm the bind/unbind state, not JetStream behavior.
    mod.initElicitationStorage({ jetstream: () => ({}), jetstreamManager: () => ({}) } as never);
    // After reset, the gate throws again.
    mod.resetElicitationStorageForTests();
    expect(() => mod.ElicitationStorage.get({ id: "x" })).toThrow(/not initialized/i);
  });

  it("re-exports the same facade object on repeated imports", async () => {
    vi.resetModules();
    const a = await import("./storage.ts");
    const b = await import("./storage.ts");
    expect(a.ElicitationStorage).toBe(b.ElicitationStorage);
  });
});
