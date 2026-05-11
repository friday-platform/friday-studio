/**
 * Integration test for the "local-user" rekey migration. Covers both
 * surfaces the migration touches: workspace registry `metadata.createdBy`
 * and chats `userId`. The chat-rekey logic mirrors the earlier
 * `m_20260504_025500` migration, which has its own multiplexing-drop
 * regression test; that's not re-tested here.
 */

import { ensureChatsKVBucket } from "@atlas/core/chat/storage";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initUserStorage, UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { createJetStreamFacade } from "jetstream";
import { connect, type KV, type NatsConnection } from "nats";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migration } from "./m_20260511_092200_rekey_local_user_records.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let chats: KV;
let registry: KVStorage;

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initUserStorage(nc);
  chats = await ensureChatsKVBucket(nc);
  registry = await createJetStreamKVStorage(nc, { bucket: "WORKSPACE_REGISTRY", history: 5 });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

afterEach(async () => {
  const chatKeys: string[] = [];
  const iter = await chats.keys();
  for await (const k of iter) chatKeys.push(k);
  for (const k of chatKeys) await chats.delete(k);
  for await (const entry of registry.list(["workspaces"])) {
    await registry.delete(entry.key);
  }
});

interface WorkspaceLike {
  id: string;
  name?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

async function seedWorkspace(id: string, createdBy: string): Promise<void> {
  const entry: WorkspaceLike = {
    id,
    name: id,
    path: `/tmp/${id}`,
    metadata: { createdBy, color: "#abcdef" },
  };
  await registry.set(["workspaces", id], entry);
}

async function readWorkspaceCreatedBy(id: string): Promise<string | undefined> {
  const got = await registry.get<WorkspaceLike>(["workspaces", id]);
  return got?.metadata?.createdBy as string | undefined;
}

async function seedChat(workspaceId: string, chatId: string, userId: string): Promise<void> {
  const key = `${workspaceId}/${chatId}`;
  const meta = {
    id: chatId,
    workspaceId,
    userId,
    source: { kind: "web" },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    title: "Test chat",
  };
  await chats.put(key, enc.encode(JSON.stringify(meta)));
}

async function readChatUserId(workspaceId: string, chatId: string): Promise<string | null> {
  const entry = await chats.get(`${workspaceId}/${chatId}`);
  if (!entry || entry.operation !== "PUT") return null;
  const meta = JSON.parse(dec.decode(entry.value)) as { userId: string };
  return meta.userId;
}

describe("m_20260511_092200_rekey_local_user_records", () => {
  it("rewrites createdBy on every local-user workspace and preserves others", async () => {
    await seedWorkspace("ws-local-1", "local-user");
    await seedWorkspace("ws-local-2", "local-user");
    await seedWorkspace("ws-real", "real-nanoid-xyz");

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    expect(await readWorkspaceCreatedBy("ws-local-1")).toBe(expectedLocal);
    expect(await readWorkspaceCreatedBy("ws-local-2")).toBe(expectedLocal);
    expect(await readWorkspaceCreatedBy("ws-real")).toBe("real-nanoid-xyz");
  });

  it("rewrites userId on every local-user chat", async () => {
    await seedChat("ws-1", "chat-1", "local-user");
    await seedChat("ws-2", "chat-2", "local-user");
    await seedChat("ws-3", "chat-3", "real-user-abc");

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    expect(await readChatUserId("ws-1", "chat-1")).toBe(expectedLocal);
    expect(await readChatUserId("ws-2", "chat-2")).toBe(expectedLocal);
    expect(await readChatUserId("ws-3", "chat-3")).toBe("real-user-abc");
  });

  it("is idempotent across both surfaces", async () => {
    await seedWorkspace("ws-local", "local-user");
    await seedChat("ws-local", "chat-local", "local-user");
    const facade = createJetStreamFacade(nc);
    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";

    await migration.run({ nc, js: facade, logger: noopLogger });
    expect(await readWorkspaceCreatedBy("ws-local")).toBe(expectedLocal);
    expect(await readChatUserId("ws-local", "chat-local")).toBe(expectedLocal);

    await migration.run({ nc, js: facade, logger: noopLogger });
    expect(await readWorkspaceCreatedBy("ws-local")).toBe(expectedLocal);
    expect(await readChatUserId("ws-local", "chat-local")).toBe(expectedLocal);
  });
});
