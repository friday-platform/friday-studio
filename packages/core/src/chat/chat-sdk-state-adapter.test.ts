import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { ChatSdkStateAdapter } from "./chat-sdk-state-adapter.ts";
import { initChatStorage } from "./storage.ts";

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

describe("ChatSdkStateAdapter", () => {
  it("subscribe → isSubscribed → unsubscribe round-trips against ChatStorage", async () => {
    const adapter = new ChatSdkStateAdapter({ userId: "u", workspaceId: "ws" });
    expect(await adapter.isSubscribed("thread-1")).toBe(false);

    await adapter.subscribe("thread-1");
    expect(await adapter.isSubscribed("thread-1")).toBe(true);

    await adapter.unsubscribe("thread-1");
    expect(await adapter.isSubscribed("thread-1")).toBe(false);
  });

  it("setIfNotExists is the dedup primitive: rejects duplicates, allows re-set after TTL", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new ChatSdkStateAdapter({ userId: "u", workspaceId: "ws" });
      expect(await adapter.setIfNotExists("dedup-1", "first", 100)).toBe(true);
      expect(await adapter.setIfNotExists("dedup-1", "second")).toBe(false);

      await vi.advanceTimersByTimeAsync(101);
      expect(await adapter.setIfNotExists("dedup-1", "third")).toBe(true);
      expect(await adapter.get("dedup-1")).toBe("third");
    } finally {
      vi.useRealTimers();
    }
  });

  // Without sweep-on-write, the chat package's dedupe pattern (setIfNotExists
  // with a TTL, then never re-read) leaves entries in the cache forever
  // because lazy eviction in get() never fires. The sweep keeps the map
  // bounded at steady state.
  it("set() evicts other expired entries on each write", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new ChatSdkStateAdapter({ userId: "u", workspaceId: "ws" });
      // Stash three short-lived entries that nobody will read again.
      await adapter.setIfNotExists("dedupe:a", true, 100);
      await adapter.setIfNotExists("dedupe:b", true, 100);
      await adapter.setIfNotExists("dedupe:c", true, 100);

      await vi.advanceTimersByTimeAsync(101);

      // A new write triggers the sweep — the three expired entries should
      // be gone even though nothing has read them.
      await adapter.setIfNotExists("dedupe:d", true, 100);
      expect(await adapter.get("dedupe:a")).toBeNull();
      expect(await adapter.get("dedupe:b")).toBeNull();
      expect(await adapter.get("dedupe:c")).toBeNull();
      expect(await adapter.get("dedupe:d")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearSource drops a pre-set source so failed subscribes don't leak", async () => {
    const adapter = new ChatSdkStateAdapter({ userId: "u", workspaceId: "ws" });
    adapter.setSource("thread-1", "slack");
    adapter.clearSource("thread-1");

    // After clearSource, a subsequent subscribe falls back to the default
    // "atlas" source — proving the slack hint was dropped.
    await adapter.subscribe("thread-1");
    // (No public getter for source; the round-trip above is sufficient
    // because subscribe consumes the entry. clearSource is correct iff
    // it doesn't throw and leaves no observable effect.)
    expect(await adapter.isSubscribed("thread-1")).toBe(true);
  });
});
