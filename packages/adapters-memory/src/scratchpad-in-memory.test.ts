import { describe, expect, it } from "vitest";
import { InMemoryScratchpadAdapter, NotImplementedError } from "./scratchpad-in-memory.ts";

describe("InMemoryScratchpadAdapter", () => {
  it("append+read roundtrip", async () => {
    const adapter = new InMemoryScratchpadAdapter();
    await adapter.append("session-1", {
      id: "c1",
      kind: "reasoning",
      body: "test body",
      createdAt: "2026-04-14T00:00:00Z",
    });

    const chunks = await adapter.read("session-1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      id: "c1",
      kind: "reasoning",
      body: "test body",
      createdAt: "2026-04-14T00:00:00Z",
    });
  });

  it("read with since filter", async () => {
    const adapter = new InMemoryScratchpadAdapter();
    await adapter.append("session-1", {
      id: "c1",
      kind: "reasoning",
      body: "early",
      createdAt: "2026-04-14T00:00:00Z",
    });
    await adapter.append("session-1", {
      id: "c2",
      kind: "reasoning",
      body: "later",
      createdAt: "2026-04-14T01:00:00Z",
    });

    const filtered = await adapter.read("session-1", { since: "2026-04-14T00:30:00Z" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: "c2" });
  });

  it("clear removes all chunks for session", async () => {
    const adapter = new InMemoryScratchpadAdapter();
    await adapter.append("session-1", {
      id: "c1",
      kind: "reasoning",
      body: "test",
      createdAt: "2026-04-14T00:00:00Z",
    });

    await adapter.clear("session-1");
    const chunks = await adapter.read("session-1");
    expect(chunks).toHaveLength(0);
  });

  it("promote throws NotImplementedError", async () => {
    const adapter = new InMemoryScratchpadAdapter();
    try {
      await adapter.promote("session", "chunk-id", { workspaceId: "ws", store: "persona" });
      expect.fail("promote should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(NotImplementedError);
      expect((e as NotImplementedError).name).toBe("NotImplementedError");
    }
  });
});
