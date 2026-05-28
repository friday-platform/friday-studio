import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { chatUploadsRoot } from "@atlas/utils/paths.server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { createJetStreamChatBackend, ensureChatsKVBucket } from "./jetstream-backend.ts";
import { ChatStorage, initChatStorage } from "./storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initChatStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

const createMessage = (text: string): AtlasUIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

const createTestChat = (chatId: string, workspaceId = "friday-conversation") =>
  ChatStorage.createChat({ chatId, userId: "test-user", workspaceId, source: "atlas" });

describe("ChatStorage (JetStream-backed)", () => {
  it("creates and retrieves a chat", async () => {
    const chatId = crypto.randomUUID();
    const create = await createTestChat(chatId);
    expect(create.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data).toBeTruthy();
    if (get.ok && get.data) {
      expect(get.data.userId).toBe("test-user");
      expect(get.data.color).toBeDefined();
    }
  });

  it("returns null for a non-existent chat", async () => {
    const result = await ChatStorage.getChat(crypto.randomUUID());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it("appends and retrieves messages", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    const msg = createMessage("hello");
    const append = await ChatStorage.appendMessage(chatId, msg);
    expect(append.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
    if (get.ok && get.data) {
      expect(get.data.messages[0]?.id).toBe(msg.id);
    }
  });

  it("persists tool-part input from rawInput on appendMessage", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    const msg = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [
        {
          type: "tool-echo-job",
          toolCallId: "toolu_persist_1",
          state: "output-error",
          rawInput: { hello: "world" },
          errorText: "Model tried to call unavailable tool 'echo-job'.",
        },
      ],
    } as unknown as AtlasUIMessage;

    const append = await ChatStorage.appendMessage(chatId, msg);
    expect(append.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
    if (get.ok && get.data) {
      const part = get.data.messages[0]?.parts[0] as Record<string, unknown> | undefined;
      expect(part?.type).toBe("tool-echo-job");
      expect(part?.state).toBe("output-error");
      expect(part?.input).toEqual({ hello: "world" });
    }
  });

  it("isolates messages between different chats", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await createTestChat(a);
    await createTestChat(b);

    await ChatStorage.appendMessage(a, createMessage("a1"));
    await ChatStorage.appendMessage(b, createMessage("b1"));
    await ChatStorage.appendMessage(b, createMessage("b2"));

    const ga = await ChatStorage.getChat(a);
    const gb = await ChatStorage.getChat(b);
    expect(ga.ok && ga.data?.messages.length).toBe(1);
    expect(gb.ok && gb.data?.messages.length).toBe(2);
  });

  it("workspace-scoped getChat is distinct from global", async () => {
    const chatId = crypto.randomUUID();
    await ChatStorage.createChat({
      chatId,
      userId: "u",
      workspaceId: "scoped_ws",
      source: "atlas",
    });

    const wsRes = await ChatStorage.getChat(chatId, "scoped_ws");
    expect(wsRes.ok && wsRes.data).toBeTruthy();

    const globalRes = await ChatStorage.getChat(chatId);
    expect(globalRes.ok && globalRes.data).toBeNull();
  });

  it("setSystemPromptContext overwrites on each call (latest wins)", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    await ChatStorage.setSystemPromptContext(chatId, { systemMessages: ["a", "b"] });
    await ChatStorage.setSystemPromptContext(chatId, { systemMessages: ["c"] });

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.systemPromptContext?.systemMessages).toEqual(["c"]);
    } else {
      throw new Error("expected chat");
    }
  });

  it("addContentFilteredMessageIds dedupes", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    await ChatStorage.addContentFilteredMessageIds(chatId, ["m1", "m2"]);
    await ChatStorage.addContentFilteredMessageIds(chatId, ["m2", "m3"]);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.contentFilteredMessageIds?.sort()).toEqual(["m1", "m2", "m3"]);
    } else {
      throw new Error("expected chat");
    }
  });

  it("updateChatTitle persists the title", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);
    const result = await ChatStorage.updateChatTitle(chatId, "My Chat");
    expect(result.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) expect(get.data.title).toBe("My Chat");
  });

  it("deleteChat removes both metadata and messages", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);
    await ChatStorage.appendMessage(chatId, createMessage("bye"));

    const del = await ChatStorage.deleteChat(chatId);
    expect(del.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data).toBeNull();
  });

  it("deleteChat GCs only the deleted workspace's scratch uploads when chat ids collide", async () => {
    const originalHome = process.env.FRIDAY_HOME;
    const tempHome = await mkdtemp(join(tmpdir(), "chat-storage-gc-"));
    process.env.FRIDAY_HOME = tempHome;
    try {
      const chatId = crypto.randomUUID();
      const wsA = `ws-a-${crypto.randomUUID()}`;
      const wsB = `ws-b-${crypto.randomUUID()}`;
      await createTestChat(chatId, wsA);
      await createTestChat(chatId, wsB);

      const rootA = chatUploadsRoot(wsA, chatId);
      const rootB = chatUploadsRoot(wsB, chatId);
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      const pathA = join(rootA, "a.txt");
      const pathB = join(rootB, "b.txt");
      await writeFile(pathA, "workspace A", { encoding: "utf8" });
      await writeFile(pathB, "workspace B", { encoding: "utf8" });

      const del = await ChatStorage.deleteChat(chatId, wsA);
      expect(del.ok).toBe(true);

      await expect(access(pathA)).rejects.toThrow();
      await expect(access(pathB)).resolves.toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.FRIDAY_HOME;
      else process.env.FRIDAY_HOME = originalHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("idempotent dedup: same Friday-Message-Id stored once", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    const msg = createMessage("once");
    await ChatStorage.appendMessage(chatId, msg);
    await ChatStorage.appendMessage(chatId, msg);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
  });

  it("snapshot replacement: re-appending same id with new content overwrites prior", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    // First snapshot — partial assistant message with one part.
    const msgId = crypto.randomUUID();
    const v1: AtlasUIMessage = {
      id: msgId,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    };
    await ChatStorage.appendMessage(chatId, v1);

    // Second snapshot — same id, more content. This is the incremental
    // snapshot path: the agent's onFinish callback running after an abort
    // would re-publish the message with whatever was assembled at that point.
    const v2: AtlasUIMessage = {
      id: msgId,
      role: "assistant",
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ],
    };
    await ChatStorage.appendMessage(chatId, v2);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
    if (get.ok && get.data) {
      const stored = get.data.messages[0];
      expect(stored?.parts.length).toBe(2);
    }
  });

  it("listChatsByWorkspace returns chats for one workspace", async () => {
    const wsId = `list-test-${crypto.randomUUID()}`;
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await ChatStorage.createChat({ chatId: a, userId: "u", workspaceId: wsId, source: "atlas" });
    await ChatStorage.createChat({ chatId: b, userId: "u", workspaceId: wsId, source: "atlas" });

    const result = await ChatStorage.listChatsByWorkspace(wsId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chats.length).toBe(2);
    }
  });

  it("supports chatIds with colons (telegram-shaped)", async () => {
    // NATS KV keys reject `:` (`/^[-/=.\w]+$/`). Telegram chatIds carry the
    // shape `telegram:<id>` — the storage must sanitize the lookup key while
    // keeping the original id in metadata. Regression test for the broken
    // path where appendMessage / getChat threw "invalid key:" on telegram
    // chats and the agent ran with empty history.
    const chatId = `telegram:${crypto.randomUUID()}`;
    const wsId = `ws-colon-${crypto.randomUUID()}`;
    const create = await ChatStorage.createChat({
      chatId,
      userId: "tg-user",
      workspaceId: wsId,
      source: "telegram",
    });
    expect(create.ok).toBe(true);

    const append = await ChatStorage.appendMessage(chatId, createMessage("hi"), wsId);
    expect(append.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId, wsId);
    expect(get.ok && get.data).toBeTruthy();
    if (get.ok && get.data) {
      expect(get.data.id).toBe(chatId);
      expect(get.data.messages.length).toBe(1);
    }

    const list = await ChatStorage.listChatsByWorkspace(wsId);
    expect(list.ok && list.data.chats.length).toBe(1);
  });

  // Defense-in-depth ACL: ChatMetadata.workspaceId is the source of
  // truth for chat ownership. Today the KV key prefix also encodes
  // workspaceId, but the storage refactor (beads friday-studio-1z9)
  // will drop that prefix. These tests pin the metadata-based check so
  // the rejection path survives the refactor.
  describe("metadata-based workspace ACL", () => {
    const enc = new TextEncoder();
    const poisonedMeta = (chatId: string, metaWorkspace: string) => ({
      id: chatId,
      userId: "poisoner",
      workspaceId: metaWorkspace,
      source: "atlas",
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });

    it("getChat returns null when KV key and metadata.workspaceId disagree", async () => {
      const kv = await ensureChatsKVBucket(nc);
      const chatId = crypto.randomUUID();
      const keyWorkspace = `wskey${crypto.randomUUID().replace(/-/g, "")}`;
      const metaWorkspace = `wsmeta${crypto.randomUUID().replace(/-/g, "")}`;
      await kv.put(
        `${keyWorkspace}/${chatId}`,
        enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))),
      );

      const get = await ChatStorage.getChat(chatId, keyWorkspace);
      expect(get.ok).toBe(true);
      if (get.ok) expect(get.data).toBeNull();
    });

    it("listChatsByWorkspace does not include chats whose metadata.workspaceId mismatches", async () => {
      const kv = await ensureChatsKVBucket(nc);
      const chatId = crypto.randomUUID();
      const keyWorkspace = `wslistkey${crypto.randomUUID().replace(/-/g, "")}`;
      const metaWorkspace = `wslistmeta${crypto.randomUUID().replace(/-/g, "")}`;
      await kv.put(
        `${keyWorkspace}/${chatId}`,
        enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))),
      );

      const list = await ChatStorage.listChatsByWorkspace(keyWorkspace);
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.data.chats.find((c) => c.id === chatId)).toBeUndefined();
      }
    });

    it("updateChatTitle fails when KV key and metadata.workspaceId disagree", async () => {
      const kv = await ensureChatsKVBucket(nc);
      const chatId = crypto.randomUUID();
      const keyWorkspace = `wsupdkey${crypto.randomUUID().replace(/-/g, "")}`;
      const metaWorkspace = `wsupdmeta${crypto.randomUUID().replace(/-/g, "")}`;
      await kv.put(
        `${keyWorkspace}/${chatId}`,
        enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))),
      );

      const result = await ChatStorage.updateChatTitle(chatId, "renamed", keyWorkspace);
      expect(result.ok).toBe(false);
    });

    // The 1z9 refactor drops `<workspaceId>/` from the KV key — under
    // new naming the key is just `<chatId>`. The defensive ACL gate
    // (metadata.workspaceId is the source of truth) must keep working,
    // since the key itself no longer carries workspaceId. These cases
    // mirror the legacy poison tests above but drive the new-naming
    // backend directly. See friday-studio-glz.
    describe("under newNamingEnabled: true", () => {
      it("getChat returns null when the bare-chatId metadata claims a different workspaceId", async () => {
        const kv = await ensureChatsKVBucket(nc);
        const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
        const chatId = `nn-poison-get-${crypto.randomUUID()}`;
        const askerWorkspace = `wsask${crypto.randomUUID().replace(/-/g, "")}`;
        const metaWorkspace = `wsreal${crypto.randomUUID().replace(/-/g, "")}`;
        // Poison: row written at the bare-chatId key, metadata claims
        // a workspace the asker is not part of.
        await kv.put(chatId, enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))));

        const get = await backend.getChat(chatId, askerWorkspace);
        expect(get.ok).toBe(true);
        if (get.ok) expect(get.data).toBeNull();
      });

      it("listChatsByWorkspace excludes new-naming rows whose metadata.workspaceId mismatches", async () => {
        const kv = await ensureChatsKVBucket(nc);
        const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
        const chatId = `nn-poison-list-${crypto.randomUUID()}`;
        const askerWorkspace = `wslistask${crypto.randomUUID().replace(/-/g, "")}`;
        const metaWorkspace = `wslistreal${crypto.randomUUID().replace(/-/g, "")}`;
        await kv.put(chatId, enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))));

        const list = await backend.listChatsByWorkspace(askerWorkspace);
        expect(list.ok).toBe(true);
        if (list.ok) {
          expect(list.data.chats.find((c) => c.id === chatId)).toBeUndefined();
        }
      });

      it("updateChatTitle fails when the bare-chatId metadata claims a different workspaceId", async () => {
        const kv = await ensureChatsKVBucket(nc);
        const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
        const chatId = `nn-poison-upd-${crypto.randomUUID()}`;
        const askerWorkspace = `wsupdask${crypto.randomUUID().replace(/-/g, "")}`;
        const metaWorkspace = `wsupdreal${crypto.randomUUID().replace(/-/g, "")}`;
        await kv.put(chatId, enc.encode(JSON.stringify(poisonedMeta(chatId, metaWorkspace))));

        const result = await backend.updateChatTitle(chatId, "renamed", askerWorkspace);
        expect(result.ok).toBe(false);
      });
    });
  });

  it("sorts messages by metadata.startTimestamp / .timestamp on read", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    // Append in completion order; expect chronological order on read.
    const a: AtlasUIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "first-started" }],
      metadata: { startTimestamp: "2026-04-01T00:00:00Z" },
    };
    const b: AtlasUIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "second-started" }],
      metadata: { startTimestamp: "2026-04-01T01:00:00Z" },
    };

    // Append b first, then a — read should reorder to a, b.
    await ChatStorage.appendMessage(chatId, b);
    await ChatStorage.appendMessage(chatId, a);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.messages.map((m) => m.id)).toEqual([a.id, b.id]);
    }
  });
});

describe("JetStream backend — new naming scheme (friday-studio-1z9)", () => {
  // Drive the backend directly with newNamingEnabled so we can verify
  // dual-read interop without touching the singleton ChatStorage facade.

  it("creates chats under the new key (no `<ws>/` prefix) when newNamingEnabled is true", async () => {
    const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    const chatId = `nn-${crypto.randomUUID()}`;
    const ws = `ws-nn-${crypto.randomUUID()}`;

    const created = await backend.createChat({
      chatId,
      userId: "u",
      workspaceId: ws,
      source: "atlas",
    });
    expect(created.ok).toBe(true);

    // KV should have the new bare-chatId key and NOT the legacy `<ws>/<chat>` key.
    const kv = await ensureChatsKVBucket(nc);
    const newEntry = await kv.get(chatId);
    expect(newEntry?.operation).toBe("PUT");
    const legacyEntry = await kv.get(`${ws}/${chatId}`);
    expect(legacyEntry).toBeNull();
  });

  it("reads a legacy-created chat even with newNamingEnabled (dual-read tolerance)", async () => {
    // Create via the legacy backend (flag off), then read via the new backend (flag on).
    const legacyBackend = createJetStreamChatBackend(nc, { newNamingEnabled: false });
    const chatId = `legacy-${crypto.randomUUID()}`;
    const ws = `ws-legacy-${crypto.randomUUID()}`;
    await legacyBackend.createChat({ chatId, userId: "u", workspaceId: ws, source: "atlas" });
    await legacyBackend.appendMessage(
      chatId,
      { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "legacy hi" }] },
      ws,
    );

    const newBackend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    const got = await newBackend.getChat(chatId, ws);
    expect(got.ok && got.data?.messages.length).toBe(1);
  });

  it("appendMessage to a legacy chat uses the legacy stream (no split-brain)", async () => {
    const legacyBackend = createJetStreamChatBackend(nc, { newNamingEnabled: false });
    const chatId = `legacy-append-${crypto.randomUUID()}`;
    const ws = `ws-la-${crypto.randomUUID()}`;
    await legacyBackend.createChat({ chatId, userId: "u", workspaceId: ws, source: "atlas" });

    // Now flag-on backend appends — should write to the LEGACY stream
    // because the chat already exists under legacy naming.
    const newBackend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    await newBackend.appendMessage(
      chatId,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "post-flag append" }],
      },
      ws,
    );
    const got = await newBackend.getChat(chatId, ws);
    expect(got.ok && got.data?.messages.length).toBe(1);
  });

  it("rejects createChat when chatId collides across workspaces under new scheme", async () => {
    const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    const chatId = `collision-${crypto.randomUUID()}`;
    const ok = await backend.createChat({
      chatId,
      userId: "u",
      workspaceId: "ws-a",
      source: "atlas",
    });
    expect(ok.ok).toBe(true);
    const conflict = await backend.createChat({
      chatId,
      userId: "u",
      workspaceId: "ws-b",
      source: "atlas",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error).toMatch(/already exists/);
    }
  });

  it("appendMessage refuses to write to a chatId owned by another workspace under new scheme", async () => {
    // ws-a creates chat X under new scheme. ws-b then tries to append
    // a message claiming chatId X. The collision gate must refuse to
    // avoid cross-writing into ws-a's stream.
    const backend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    const chatId = `xws-${crypto.randomUUID()}`;
    const wsA = `ws-a-${crypto.randomUUID()}`;
    const wsB = `ws-b-${crypto.randomUUID()}`;
    await backend.createChat({ chatId, userId: "u", workspaceId: wsA, source: "atlas" });

    const result = await backend.appendMessage(
      chatId,
      { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "cross-pollute" }] },
      wsB,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/belongs to workspace/);
    }
    // ws-a's chat still has zero messages — no cross-pollution happened.
    const aGet = await backend.getChat(chatId, wsA);
    expect(aGet.ok && aGet.data?.messages.length).toBe(0);
  });

  it("deleteChat under new scheme removes only the targeted chat (no cross-scheme smash)", async () => {
    const chatId = `del-${crypto.randomUUID()}`;
    const wsLegacy = `ws-leg-${crypto.randomUUID()}`;
    const wsNew = `ws-new-${crypto.randomUUID()}`;
    // Same chatId under both schemes in different workspaces.
    const legacyBackend = createJetStreamChatBackend(nc, { newNamingEnabled: false });
    await legacyBackend.createChat({ chatId, userId: "u", workspaceId: wsLegacy, source: "atlas" });
    const newBackend = createJetStreamChatBackend(nc, { newNamingEnabled: true });
    await newBackend.createChat({ chatId, userId: "u", workspaceId: wsNew, source: "atlas" });

    // Delete only the new-scheme one.
    await newBackend.deleteChat(chatId, wsNew);

    // Legacy chat survives.
    const legacyAfter = await legacyBackend.getChat(chatId, wsLegacy);
    expect(legacyAfter.ok && legacyAfter.data).toBeTruthy();
    // New-scheme chat is gone.
    const newAfter = await newBackend.getChat(chatId, wsNew);
    expect(newAfter.ok && newAfter.data).toBeNull();
  });
});
