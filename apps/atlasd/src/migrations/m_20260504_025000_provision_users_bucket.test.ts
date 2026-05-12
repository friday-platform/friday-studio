/**
 * Integration test for the USERS bucket backfill migration.
 *
 * Seeds the legacy memory store (`user/notes`) with a `metadata.type:
 * "user-name"` entry, runs the migration, asserts USERS now has the
 * extracted name and onboarding marked complete.
 */

import { JetStreamNarrativeStore } from "@atlas/adapters-md";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initUserStorage, ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamFacade } from "jetstream";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migration } from "./m_20260504_025000_provision_users_bucket.ts";

let server: TestNatsServer;
let nc: NatsConnection;

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initUserStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

async function clearKVBucket(name: string): Promise<void> {
  const js = nc.jetstream();
  try {
    const kv = await js.views.kv(name);
    const keysIter = await kv.keys();
    const keys: string[] = [];
    for await (const k of keysIter) keys.push(k);
    for (const k of keys) await kv.delete(k);
  } catch {
    // bucket may not exist yet
  }
}

async function deleteStream(name: string): Promise<void> {
  try {
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete(name);
  } catch {
    // stream may not exist
  }
}

beforeEach(async () => {
  // Fresh state per test. The USERS bucket holds the cached
  // local-user id pointer; the narrative entries we seed live in
  // the JetStream memory stream + MEMORY_INDEX KV. Clear all three
  // so each test starts from a clean broker.
  await clearKVBucket("USERS");
  await deleteStream("MEMORY_user_notes");
  await clearKVBucket("MEMORY_INDEX");
  // Re-init drops the cached local-user id.
  initUserStorage(nc);
});

describe("m_20260504_025000_provision_users_bucket", () => {
  it("backfills USERS with the name extracted from a legacy memory entry", async () => {
    // Seed: legacy onboarding wrote into `user/notes` narrative with
    // `metadata.type: "user-name"` and a body like "name is Ken".
    const store = new JetStreamNarrativeStore({ nc, workspaceId: "user", name: "notes" });
    await store.append({
      id: crypto.randomUUID(),
      text: "name is Alex",
      createdAt: new Date().toISOString(),
      metadata: { type: "user-name" },
    });

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const localUserId = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(localUserId);
    expect(got.ok).toBe(true);
    if (got.ok && got.data) {
      expect(got.data.identity.name).toBe("Alex");
      expect(got.data.identity.nameStatus).toBe("provided");
      expect(got.data.onboarding.version).toBe(ONBOARDING_VERSION);
      expect(got.data.onboarding.completedAt).toBeDefined();
    }
  });

  it("backfills declined state from a name-declined entry", async () => {
    const store = new JetStreamNarrativeStore({ nc, workspaceId: "user", name: "notes" });
    await store.append({
      id: crypto.randomUUID(),
      text: "user opted out",
      createdAt: new Date().toISOString(),
      metadata: { type: "name-declined" },
    });

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const localUserId = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(localUserId);
    expect(got.ok).toBe(true);
    if (got.ok && got.data) {
      expect(got.data.identity.nameStatus).toBe("declined");
      expect(got.data.onboarding.completedAt).toBeDefined();
    }
  });

  it("is a no-op when USERS already has a non-unknown nameStatus", async () => {
    // Pre-seed USERS so the migration should skip.
    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const localUserId = localResult.ok ? localResult.data : "";
    await UserStorage.setUserIdentity(localUserId, { name: "Existing", nameStatus: "provided" });

    // Seed a contradicting legacy entry — migration should NOT overwrite.
    const store = new JetStreamNarrativeStore({ nc, workspaceId: "user", name: "notes" });
    await store.append({
      id: crypto.randomUUID(),
      text: "name is Override",
      createdAt: new Date().toISOString(),
      metadata: { type: "user-name" },
    });

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(localUserId);
    expect(got.ok && got.data?.identity.name).toBe("Existing");
  });

  it("is a no-op when onboarding.version is already at target (partial-rerun crash recovery)", async () => {
    // Crash-recovery scenario: a prior run successfully called
    // `markOnboardingComplete` (bumping `onboarding.version` to the
    // current value) but the identity write either crashed or was
    // never reached for this user, so `nameStatus` is still
    // `"unknown"`. Without clause (b) of the idempotency guard, the
    // migration would re-derive identity from legacy memory on the
    // rerun and clobber whatever state the operator may have edited
    // manually since the crash. Clause (b) protects against that.
    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const localUserId = localResult.ok ? localResult.data : "";

    // Pre-seed onboarding.version at target without touching identity.
    // (`nameStatus` stays at the default "unknown" from `resolveLocalUserId`.)
    const mark = await UserStorage.markOnboardingComplete(localUserId, ONBOARDING_VERSION);
    expect(mark.ok).toBe(true);

    // Seed a legacy memory entry the migration WOULD pick up if it ran.
    const store = new JetStreamNarrativeStore({ nc, workspaceId: "user", name: "notes" });
    await store.append({
      id: crypto.randomUUID(),
      text: "name is StaleLegacy",
      createdAt: new Date().toISOString(),
      metadata: { type: "user-name" },
    });

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    // Identity must remain `unknown` — the migration short-circuited.
    const got = await UserStorage.getUser(localUserId);
    expect(got.ok).toBe(true);
    if (got.ok && got.data) {
      expect(got.data.identity.nameStatus).toBe("unknown");
      expect(got.data.identity.name).toBeUndefined();
      expect(got.data.onboarding.version).toBe(ONBOARDING_VERSION);
    }
  });

  it("is a no-op when no legacy identity entries exist", async () => {
    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const localUserId = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(localUserId);
    expect(got.ok).toBe(true);
    if (got.ok && got.data) {
      expect(got.data.identity.nameStatus).toBe("unknown");
    }
  });
});
