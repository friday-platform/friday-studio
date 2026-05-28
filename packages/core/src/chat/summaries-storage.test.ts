import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { ChatSummariesStorage, initChatSummariesStorage } from "./summaries-storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initChatSummariesStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

const summary = (overrides: Partial<Parameters<typeof ChatSummariesStorage.put>[1]> = {}) => ({
  summary: "Decisions: ship today.",
  messageCount: 42,
  modelId: "claude-haiku-4-5",
  generatedAt: "2026-05-22T00:00:00.000Z",
  ...overrides,
});

describe("ChatSummariesStorage (JetStream-backed)", () => {
  it("round-trips a summary under the same key tuple (cache hit)", async () => {
    const key = {
      workspaceId: `ws-hit-${crypto.randomUUID()}`,
      chatId: `chat-${crypto.randomUUID()}`,
      updatedAtMs: 1_700_000_000_000,
      focusHash: "focus-a",
    };
    const payload = summary({ summary: "stored body" });
    await ChatSummariesStorage.put(key, payload);
    const got = await ChatSummariesStorage.get(key);
    expect(got).toEqual(payload);
  });

  it("bumping updatedAtMs misses the cache (new key)", async () => {
    const base = {
      workspaceId: `ws-bump-${crypto.randomUUID()}`,
      chatId: `chat-${crypto.randomUUID()}`,
      updatedAtMs: 1_700_000_000_000,
      focusHash: "focus-a",
    };
    await ChatSummariesStorage.put(base, summary({ summary: "old" }));
    const got = await ChatSummariesStorage.get({ ...base, updatedAtMs: base.updatedAtMs + 1 });
    expect(got).toBeNull();
  });

  it("different focusHash misses the cache (focus participates in the key)", async () => {
    const base = {
      workspaceId: `ws-focus-${crypto.randomUUID()}`,
      chatId: `chat-${crypto.randomUUID()}`,
      updatedAtMs: 1_700_000_000_000,
      focusHash: "focus-default",
    };
    await ChatSummariesStorage.put(base, summary({ summary: "default-focus" }));
    const got = await ChatSummariesStorage.get({ ...base, focusHash: "focus-other" });
    expect(got).toBeNull();
  });

  it("chatIds that previously collided under the old sanitizer hash distinctly (friday-studio-ejb)", async () => {
    // Earlier revisions of kvKey stripped non-[A-Za-z0-9_-], collapsing
    // `team.demo` and `team_demo` to the same key. The SHA-256-of-tuple
    // implementation must keep them distinct.
    const ws = `ws-collide-${crypto.randomUUID()}`;
    const dotKey = {
      workspaceId: ws,
      chatId: "team.demo",
      updatedAtMs: 1_700_000_000_000,
      focusHash: "f",
    };
    const underscoreKey = { ...dotKey, chatId: "team_demo" };

    await ChatSummariesStorage.put(dotKey, summary({ summary: "dot-body" }));
    await ChatSummariesStorage.put(underscoreKey, summary({ summary: "underscore-body" }));

    const dotGot = await ChatSummariesStorage.get(dotKey);
    const underscoreGot = await ChatSummariesStorage.get(underscoreKey);
    expect(dotGot?.summary).toBe("dot-body");
    expect(underscoreGot?.summary).toBe("underscore-body");
  });
});
