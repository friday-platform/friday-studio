/**
 * Integration test for the userId-as-name cleanup migration.
 *
 * Seeds a USERS record that matches the poisoned-record fingerprint
 * (name = userId, email = <userId>@local.friday, nameStatus = provided,
 * onboarding marked complete), runs the migration, asserts the record
 * was reset to pre-onboarding state. Plus negative cases for records
 * that look similar but should be left alone.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import {
  ensureUsersKVBucket,
  initUserStorage,
  ONBOARDING_VERSION,
  UserSchema,
  UserStorage,
} from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamFacade } from "jetstream";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migration } from "./m_20260511_120000_cleanup_userid_as_name.ts";

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

beforeEach(async () => {
  await clearKVBucket("USERS");
  initUserStorage(nc);
});

/** Write a User record straight to KV at the given key, matching the
 *  exact byte shape `setUserIdentity` would produce. The migration
 *  reads/writes via raw KV, so we seed the same way. */
async function writeUserRecord(
  userId: string,
  identity: Partial<ReturnType<typeof UserSchema.parse>["identity"]> & {
    nameStatus: "unknown" | "provided" | "declined";
  },
  onboarding: { version: number; completedAt?: string } = { version: 0 },
): Promise<void> {
  const kv = await ensureUsersKVBucket(nc);
  const now = new Date().toISOString();
  const record = UserSchema.parse({
    userId,
    identity: { ...identity },
    preferences: {},
    onboarding,
    createdAt: now,
    updatedAt: now,
  });
  await kv.put(userId, new TextEncoder().encode(JSON.stringify(record)));
}

describe("m_20260511_120000_cleanup_userid_as_name", () => {
  it("resets a poisoned record to pre-onboarding state", async () => {
    const userId = "poisoned123";
    await writeUserRecord(
      userId,
      { name: userId, email: `${userId}@local.friday`, nameStatus: "provided" },
      { version: ONBOARDING_VERSION, completedAt: new Date().toISOString() },
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(userId);
    expect(got.ok).toBe(true);
    if (got.ok && got.data) {
      expect(got.data.identity.nameStatus).toBe("unknown");
      expect(got.data.identity.name).toBeUndefined();
      expect(got.data.identity.email).toBeUndefined();
      expect(got.data.onboarding.version).toBe(0);
      expect(got.data.onboarding.completedAt).toBeUndefined();
    }
  });

  it("preserves timezone and locale when resetting", async () => {
    const userId = "poisoned456";
    await writeUserRecord(
      userId,
      {
        name: userId,
        email: `${userId}@local.friday`,
        timezone: "America/New_York",
        locale: "en-US",
        nameStatus: "provided",
      },
      { version: ONBOARDING_VERSION, completedAt: new Date().toISOString() },
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(userId);
    expect(got.ok && got.data?.identity.timezone).toBe("America/New_York");
    expect(got.ok && got.data?.identity.locale).toBe("en-US");
  });

  it("leaves a legitimately-onboarded record alone", async () => {
    const userId = "realuser1";
    await writeUserRecord(
      userId,
      { name: "Alex", email: "alex@example.com", nameStatus: "provided" },
      { version: ONBOARDING_VERSION, completedAt: new Date().toISOString() },
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(userId);
    expect(got.ok && got.data?.identity.name).toBe("Alex");
    expect(got.ok && got.data?.identity.nameStatus).toBe("provided");
    expect(got.ok && got.data?.onboarding.completedAt).toBeDefined();
  });

  it("leaves a name=userId but email!=placeholder record alone", async () => {
    // Edge case: a user named themselves with a string that happens to
    // equal their userId. Their email doesn't match the placeholder
    // pattern, so the detection criteria require all-three-match —
    // this record is not poisoned.
    const userId = "weirdname1";
    await writeUserRecord(
      userId,
      { name: userId, email: "real@example.com", nameStatus: "provided" },
      { version: ONBOARDING_VERSION, completedAt: new Date().toISOString() },
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(userId);
    expect(got.ok && got.data?.identity.name).toBe(userId);
    expect(got.ok && got.data?.identity.nameStatus).toBe("provided");
  });

  it("leaves a record with nameStatus=unknown alone (already pre-onboarding)", async () => {
    const userId = "freshuser1";
    await writeUserRecord(userId, { nameStatus: "unknown" });

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const got = await UserStorage.getUser(userId);
    expect(got.ok && got.data?.identity.nameStatus).toBe("unknown");
  });

  it("is idempotent — a second run finds nothing to reset", async () => {
    const userId = "poisoned789";
    await writeUserRecord(
      userId,
      { name: userId, email: `${userId}@local.friday`, nameStatus: "provided" },
      { version: ONBOARDING_VERSION, completedAt: new Date().toISOString() },
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });
    // Capture the post-first-run state.
    const first = await UserStorage.getUser(userId);
    const firstUpdatedAt = first.ok && first.data ? first.data.updatedAt : "";

    await migration.run({ nc, js: facade, logger: noopLogger });
    const second = await UserStorage.getUser(userId);
    // No further writes mean updatedAt didn't bump.
    expect(second.ok && second.data?.updatedAt).toBe(firstUpdatedAt);
  });
});
