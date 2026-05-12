/**
 * Integration test for the chat rekey migration.
 *
 * Specifically guards against the bug this migration shipped with:
 * iterating `kv.keys()` while issuing `kv.get`/`kv.update` inside the
 * loop silently dropped later keys (NATS JS-KV consumer multiplexing).
 * Seeds N legacy chats, runs migration, asserts ALL N are rekeyed.
 */

import { ensureChatsKVBucket } from "@atlas/core/chat/storage";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initUserStorage, UserStorage } from "@atlas/core/users/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamFacade } from "jetstream";
import { connect, type KV, type NatsConnection } from "nats";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migration } from "./m_20260504_025500_rekey_default_user_chats.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let kv: KV;

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
  kv = await ensureChatsKVBucket(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

afterEach(async () => {
  // Purge CHATS bucket between tests.
  const keys: string[] = [];
  const iter = await kv.keys();
  for await (const k of iter) keys.push(k);
  for (const k of keys) await kv.delete(k);
});

interface LegacyMeta {
  id: string;
  workspaceId: string;
  userId: string;
  source: { kind: string };
  createdAt: string;
  updatedAt: string;
  title?: string;
}

function legacyMeta(workspaceId: string, chatId: string, userId: string): LegacyMeta {
  return {
    id: chatId,
    workspaceId,
    userId,
    source: { kind: "web" },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    title: "Test chat",
  };
}

async function seedChat(workspaceId: string, chatId: string, userId: string): Promise<void> {
  const key = `${workspaceId}/${chatId}`;
  await kv.put(key, enc.encode(JSON.stringify(legacyMeta(workspaceId, chatId, userId))));
}

async function readUserId(workspaceId: string, chatId: string): Promise<string | null> {
  const key = `${workspaceId}/${chatId}`;
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") return null;
  const meta = JSON.parse(dec.decode(entry.value)) as { userId: string };
  return meta.userId;
}

describe("m_20260504_025500_rekey_default_user_chats", () => {
  it("rewrites userId on every default-user chat (no silent drops)", async () => {
    // Seed enough chats that an iterator-with-mutations bug would
    // surface. The original implementation dropped 5/6 chats; using
    // 12 here keeps it clearly distinct from the fixed-pattern.
    const N = 12;
    const seeded: Array<{ ws: string; chat: string }> = [];
    for (let i = 0; i < N; i++) {
      const ws = `ws-${i}`;
      const chat = `chat-${i}`;
      seeded.push({ ws, chat });
      await seedChat(ws, chat, "default-user");
    }
    // Plant one chat already on a real userId to verify it's untouched.
    await seedChat("ws-real", "chat-real", "real-user-abc");

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    for (const { ws, chat } of seeded) {
      const got = await readUserId(ws, chat);
      expect(got, `chat ${ws}/${chat} should be rekeyed`).toBe(expectedLocal);
    }
    // Pre-existing real user untouched.
    expect(await readUserId("ws-real", "chat-real")).toBe("real-user-abc");
  });

  it("is a no-op the second time (idempotent)", async () => {
    await seedChat("ws-1", "chat-1", "default-user");
    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";
    const afterFirst = await readUserId("ws-1", "chat-1");
    expect(afterFirst).toBe(expectedLocal);

    // Second run — no entries left to rewrite.
    await migration.run({ nc, js: facade, logger: noopLogger });
    const afterSecond = await readUserId("ws-1", "chat-1");
    expect(afterSecond).toBe(expectedLocal);
  });

  it("skips malformed entries without aborting the run", async () => {
    // Plant a junk JSON record alongside two legitimate ones.
    await kv.put("ws-junk/chat-junk", enc.encode("{not valid json"));
    await seedChat("ws-1", "chat-1", "default-user");
    await seedChat("ws-2", "chat-2", "default-user");

    const localResult = await UserStorage.resolveLocalUserId();
    expect(localResult.ok).toBe(true);
    const expectedLocal = localResult.ok ? localResult.data : "";

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    expect(await readUserId("ws-1", "chat-1")).toBe(expectedLocal);
    expect(await readUserId("ws-2", "chat-2")).toBe(expectedLocal);
  });
});
