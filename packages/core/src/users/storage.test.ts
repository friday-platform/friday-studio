import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { initUserStorage, ONBOARDING_VERSION, UserStorage } from "./storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initUserStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

describe("UserStorage (JetStream-backed)", () => {
  it("returns null for an unknown user", async () => {
    const got = await UserStorage.getUser("does-not-exist");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.data).toBeNull();
  });

  it("ensureUser creates an empty record when missing", async () => {
    const userId = crypto.randomUUID();
    const created = await UserStorage.ensureUser(userId);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.data.userId).toBe(userId);
      expect(created.data.identity.nameStatus).toBe("unknown");
      expect(created.data.onboarding.version).toBe(0);
      expect(created.data.preferences).toEqual({});
    }
  });

  it("ensureUser is idempotent — returns existing record on repeat calls", async () => {
    const userId = crypto.randomUUID();
    const first = await UserStorage.ensureUser(userId, { name: "first" });
    expect(first.ok && first.data.identity.name === "first").toBe(true);
    const second = await UserStorage.ensureUser(userId, { name: "second" });
    expect(second.ok && second.data.identity.name === "first").toBe(true);
  });

  it("setUserIdentity merges identity fields", async () => {
    const userId = crypto.randomUUID();
    await UserStorage.ensureUser(userId);
    const set = await UserStorage.setUserIdentity(userId, { name: "Ken", nameStatus: "provided" });
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.data.identity.name).toBe("Ken");
      expect(set.data.identity.nameStatus).toBe("provided");
    }
  });

  it("setUserIdentity creates the User if missing", async () => {
    const userId = crypto.randomUUID();
    const set = await UserStorage.setUserIdentity(userId, {
      name: "Alice",
      nameStatus: "provided",
    });
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.data.userId).toBe(userId);
      expect(set.data.identity.name).toBe("Alice");
    }
  });

  it("markOnboardingComplete sets completedAt + version", async () => {
    const userId = crypto.randomUUID();
    await UserStorage.ensureUser(userId);
    const marked = await UserStorage.markOnboardingComplete(userId, ONBOARDING_VERSION);
    expect(marked.ok).toBe(true);
    if (marked.ok) {
      expect(marked.data.onboarding.completedAt).toBeTruthy();
      expect(marked.data.onboarding.version).toBe(ONBOARDING_VERSION);
    }
  });

  it("resolveLocalUserId generates an id on first call and returns it on subsequent calls", async () => {
    const first = await UserStorage.resolveLocalUserId();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("resolveLocalUserId failed");
    expect(first.data).toMatch(/^[0-9a-zA-Z]{12}$/);

    const second = await UserStorage.resolveLocalUserId();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data).toBe(first.data);

    // The User record itself should exist for the resolved id.
    const user = await UserStorage.getUser(first.data);
    expect(user.ok && user.data?.userId === first.data).toBe(true);
  });
});
