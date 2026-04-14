import { describe, expect, it, vi } from "vitest";
import type { ScratchpadAdapter, ScratchpadChunk } from "../scratchpad-adapter.ts";

function makeAdapter(): ScratchpadAdapter {
  return {
    append: vi
      .fn<(sessionKey: string, chunk: ScratchpadChunk) => Promise<void>>()
      .mockResolvedValue(undefined),
    read: vi
      .fn<(sessionKey: string, opts?: { since?: string }) => Promise<ScratchpadChunk[]>>()
      .mockResolvedValue([]),
    clear: vi.fn<(sessionKey: string) => Promise<void>>().mockResolvedValue(undefined),
    promote: vi.fn().mockResolvedValue({ id: "1", text: "", createdAt: "" }),
  };
}

describe("ScratchpadAdapter interface shape", () => {
  it("has append method", () => {
    const adapter = makeAdapter();
    expect(typeof adapter.append).toBe("function");
  });

  it("has read method", () => {
    const adapter = makeAdapter();
    expect(typeof adapter.read).toBe("function");
  });

  it("has clear method", () => {
    const adapter = makeAdapter();
    expect(typeof adapter.clear).toBe("function");
  });

  it("has promote method", () => {
    const adapter = makeAdapter();
    expect(typeof adapter.promote).toBe("function");
  });

  it("ScratchpadChunk has required fields", () => {
    const chunk: ScratchpadChunk = {
      id: "chunk-1",
      kind: "proposed-config",
      body: "test body",
      createdAt: new Date().toISOString(),
    };
    expect(chunk.id).toBe("chunk-1");
    expect(chunk.kind).toBe("proposed-config");
    expect(chunk.body).toBe("test body");
    expect(typeof chunk.createdAt).toBe("string");
  });
});
