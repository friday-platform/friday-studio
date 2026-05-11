import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import {
  initWorkspaceMemberStorage,
  resetWorkspaceMemberStorageForTests,
  WorkspaceMemberStorage,
} from "./storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initWorkspaceMemberStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
  resetWorkspaceMemberStorageForTests();
});

beforeEach(() => {
  // Fresh ids per test so the bucket-shared state across tests doesn't
  // leak (the NATS test server lives for the whole suite).
});

const u = () => `u_${crypto.randomUUID().slice(0, 8)}`;
const w = () => `w_${crypto.randomUUID().slice(0, 8)}`;

describe("WorkspaceMemberStorage", () => {
  it("get returns null for an unknown (user, workspace)", async () => {
    const got = await WorkspaceMemberStorage.get(u(), w());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.data).toBeNull();
  });

  it("put writes a row and get reads it back", async () => {
    const userId = u();
    const wsId = w();
    const put = await WorkspaceMemberStorage.put({
      userId,
      wsId,
      role: "owner",
      addedAt: new Date().toISOString(),
    });
    expect(put.ok).toBe(true);
    const got = await WorkspaceMemberStorage.get(userId, wsId);
    expect(got.ok && got.data?.role).toBe("owner");
    expect(got.ok && got.data?.userId).toBe(userId);
    expect(got.ok && got.data?.wsId).toBe(wsId);
  });

  it("put overwrites an existing row (last-write-wins)", async () => {
    const userId = u();
    const wsId = w();
    await WorkspaceMemberStorage.put({
      userId,
      wsId,
      role: "member",
      addedAt: new Date().toISOString(),
    });
    await WorkspaceMemberStorage.put({
      userId,
      wsId,
      role: "admin",
      addedAt: new Date().toISOString(),
    });
    const got = await WorkspaceMemberStorage.get(userId, wsId);
    expect(got.ok && got.data?.role).toBe("admin");
  });

  it("putIfAbsent writes a row only when none exists", async () => {
    const userId = u();
    const wsId = w();
    const first = await WorkspaceMemberStorage.putIfAbsent({
      userId,
      wsId,
      role: "owner",
      addedAt: new Date().toISOString(),
    });
    expect(first.ok && first.data !== "exists").toBe(true);

    const second = await WorkspaceMemberStorage.putIfAbsent({
      userId,
      wsId,
      role: "member",
      addedAt: new Date().toISOString(),
    });
    expect(second.ok && second.data === "exists").toBe(true);

    // The original row stands — the second putIfAbsent didn't change role.
    const got = await WorkspaceMemberStorage.get(userId, wsId);
    expect(got.ok && got.data?.role).toBe("owner");
  });

  it("listByUser returns every workspace the user belongs to", async () => {
    const userId = u();
    const wsA = w();
    const wsB = w();
    const wsC = w();
    const noiseUser = u();
    await WorkspaceMemberStorage.put({
      userId,
      wsId: wsA,
      role: "owner",
      addedAt: new Date().toISOString(),
    });
    await WorkspaceMemberStorage.put({
      userId,
      wsId: wsB,
      role: "member",
      addedAt: new Date().toISOString(),
    });
    await WorkspaceMemberStorage.put({
      userId,
      wsId: wsC,
      role: "agent",
      addedAt: new Date().toISOString(),
    });
    // Another user on one of the same workspaces — should not show up.
    await WorkspaceMemberStorage.put({
      userId: noiseUser,
      wsId: wsA,
      role: "admin",
      addedAt: new Date().toISOString(),
    });

    const list = await WorkspaceMemberStorage.listByUser(userId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      const wsIds = list.data.map((m) => m.wsId).sort();
      expect(wsIds).toEqual([wsA, wsB, wsC].sort());
      for (const m of list.data) expect(m.userId).toBe(userId);
    }
  });

  it("listByWorkspace returns every user who belongs to the workspace", async () => {
    const wsId = w();
    const userA = u();
    const userB = u();
    const userC = u();
    const noiseWs = w();
    await WorkspaceMemberStorage.put({
      userId: userA,
      wsId,
      role: "owner",
      addedAt: new Date().toISOString(),
    });
    await WorkspaceMemberStorage.put({
      userId: userB,
      wsId,
      role: "admin",
      addedAt: new Date().toISOString(),
    });
    await WorkspaceMemberStorage.put({
      userId: userC,
      wsId,
      role: "member",
      addedAt: new Date().toISOString(),
    });
    // Same user on a different workspace — should not show up.
    await WorkspaceMemberStorage.put({
      userId: userA,
      wsId: noiseWs,
      role: "owner",
      addedAt: new Date().toISOString(),
    });

    const list = await WorkspaceMemberStorage.listByWorkspace(wsId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      const userIds = list.data.map((m) => m.userId).sort();
      expect(userIds).toEqual([userA, userB, userC].sort());
    }
  });

  it("delete removes a row", async () => {
    const userId = u();
    const wsId = w();
    await WorkspaceMemberStorage.put({
      userId,
      wsId,
      role: "member",
      addedAt: new Date().toISOString(),
    });
    const del = await WorkspaceMemberStorage.delete(userId, wsId);
    expect(del.ok).toBe(true);
    const got = await WorkspaceMemberStorage.get(userId, wsId);
    expect(got.ok && got.data).toBeNull();
  });

  it("delete is a no-op when the row doesn't exist", async () => {
    const del = await WorkspaceMemberStorage.delete(u(), w());
    expect(del.ok).toBe(true);
  });

  it("rejects invalid role values at put-time", async () => {
    const bad = await WorkspaceMemberStorage.put({
      userId: u(),
      wsId: w(),
      // @ts-expect-error - exercising the runtime guard
      role: "superuser",
      addedAt: new Date().toISOString(),
    });
    expect(bad.ok).toBe(false);
  });
});
