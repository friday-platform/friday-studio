/**
 * Regression tests for `resolveLocalUserId()` stability — Phase 1 of the
 * friday-home-isolation plan.
 *
 * The resolver uses pointer-first CAS-create on the `_local` key of the
 * USERS KV bucket. Within a single JetStream store, every process that
 * resolves a local user id MUST return the same nanoid on every
 * invocation, indefinitely. The four scenarios covered below match the
 * Phase 1 gate verbatim:
 *
 *   1. Sequential boots against an empty store return byte-identical ids.
 *   2. Two backends racing concurrently against an empty store agree on
 *      the same id; only the winner's USERS record is written (no
 *      orphan record under the loser's rejected candidate).
 *   3. A "CLI" backend created against the same NATS connection while a
 *      "daemon" backend already resolved sees the daemon's id.
 *   4. A backend that resolved against a JetStream store, was dropped
 *      cleanly, and then a second backend boots against the same store
 *      (same NATS broker) sees the same id.
 *
 * Scenarios (3) and (4) collapse to the same primitive at the
 * NATS-protocol layer — a new backend instance reading the store. The
 * difference is operational (broker liveness across the gap), not
 * semantic. We exercise both shapes anyway to lock in the contract the
 * way callers reason about it.
 */

import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { createJetStreamUserBackend, ensureUsersKVBucket } from "./jetstream-backend.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

/**
 * Wipe the USERS bucket so each scenario starts from a truly-empty
 * store. The bucket is backed by the `KV_USERS` JetStream stream;
 * deleting and re-creating it resets revision counters too, which is
 * what we want for the "empty store on first boot" precondition.
 */
async function resetUsersBucket(): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.delete("KV_USERS");
  } catch {
    // bucket may not exist yet
  }
  // Recreate via the same path the resolver uses, so options match prod.
  await ensureUsersKVBucket(nc);
}

beforeEach(async () => {
  await resetUsersBucket();
});

describe("resolveLocalUserId — stability within a single JetStream store", () => {
  it("sequential boots against an empty store return the same id", async () => {
    // First "boot": create backend, resolve, capture id, drop backend.
    const first = createJetStreamUserBackend(nc);
    const firstResult = await first.resolveLocalUserId();
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error("first resolve failed");
    const firstId = firstResult.data;
    expect(firstId).toMatch(/^[0-9A-Za-z]{12}$/);

    // Second "boot": brand-new backend against the same KV.
    const second = createJetStreamUserBackend(nc);
    const secondResult = await second.resolveLocalUserId();
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) throw new Error("second resolve failed");

    expect(secondResult.data).toBe(firstId);

    // Third boot — paranoia, lock in indefinite stability.
    const third = createJetStreamUserBackend(nc);
    const thirdResult = await third.resolveLocalUserId();
    expect(thirdResult.ok).toBe(true);
    if (!thirdResult.ok) throw new Error("third resolve failed");
    expect(thirdResult.data).toBe(firstId);
  });

  it("two backends racing on first boot agree on the same id with no orphan records (N iterations)", async () => {
    // Single-threaded event loop means `Promise.all` doesn't guarantee
    // the CAS-conflict branch fires every iteration — micro-task
    // scheduling can serialise the two backends. We loop N=20 fresh-
    // bucket races so the conflict branch is hit by birthday-paradox
    // at least once, and assert the invariants hold every iteration
    // regardless of which path the resolver took.
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) {
      // Reset the bucket each iteration so each race starts empty.
      // beforeEach only fires once per `it` — manual reset for the loop.
      await resetUsersBucket();

      const a = createJetStreamUserBackend(nc);
      const b = createJetStreamUserBackend(nc);

      const [resultA, resultB] = await Promise.all([
        a.resolveLocalUserId(),
        b.resolveLocalUserId(),
      ]);
      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (!resultA.ok || !resultB.ok) throw new Error(`iter ${i}: concurrent resolve failed`);

      expect(resultA.data).toBe(resultB.data);
      const winnerId = resultA.data;

      // Inspect the bucket directly — there must be exactly one User
      // record (the winner) plus the `_local` pointer. A failure mode
      // we explicitly guard against: the loser writing a User record
      // under its (rejected) candidate nanoid before reading the
      // winner's pointer.
      const kv = await ensureUsersKVBucket(nc);
      const keys: string[] = [];
      const keysIter = await kv.keys();
      for await (const k of keysIter) keys.push(k);
      const userKeys = keys.filter((k) => k !== "_local");
      expect(userKeys).toEqual([winnerId]);

      const pointerEntry = await kv.get("_local");
      expect(pointerEntry).not.toBeNull();
      if (!pointerEntry) throw new Error(`iter ${i}: pointer missing`);
      expect(new TextDecoder().decode(pointerEntry.value)).toBe(winnerId);
    }
  });

  it("a CLI backend on the same broker as a running daemon sees the daemon's id", async () => {
    // "Daemon" boots, resolves, populates `_local`.
    const daemon = createJetStreamUserBackend(nc);
    const daemonResult = await daemon.resolveLocalUserId();
    expect(daemonResult.ok).toBe(true);
    if (!daemonResult.ok) throw new Error("daemon resolve failed");
    const daemonId = daemonResult.data;

    // "CLI" connects to the same NATS server (same KV store), boots
    // its own backend instance, resolves. Must see the daemon's id —
    // not generate a fresh one, not race with the daemon's pointer.
    const cli = createJetStreamUserBackend(nc);
    const cliResult = await cli.resolveLocalUserId();
    expect(cliResult.ok).toBe(true);
    if (!cliResult.ok) throw new Error("cli resolve failed");
    expect(cliResult.data).toBe(daemonId);
  });

  it("a second backend booted after the first was dropped sees the persisted id", async () => {
    // Backend A: resolve, then drop (no explicit teardown — the
    // resolver has no per-instance state on disk; the in-memory
    // cache lives on the backend object that's about to be GC'd).
    const backendA = createJetStreamUserBackend(nc);
    const aResult = await backendA.resolveLocalUserId();
    expect(aResult.ok).toBe(true);
    if (!aResult.ok) throw new Error("backend A resolve failed");
    const persistedId = aResult.data;

    // Simulate "broker stays up but caller restarts." A fresh backend
    // instance has zero in-memory state and must read the pointer
    // from JetStream KV.
    const backendB = createJetStreamUserBackend(nc);
    const bResult = await backendB.resolveLocalUserId();
    expect(bResult.ok).toBe(true);
    if (!bResult.ok) throw new Error("backend B resolve failed");
    expect(bResult.data).toBe(persistedId);

    // The cached-on-instance accessor must reflect the same id —
    // protects against a regression where the cache desyncs from the
    // KV pointer (e.g. some future refactor that races cache writes
    // against KV writes).
    expect(backendB.getCachedLocalUserId()).toBe(persistedId);
  });
});
