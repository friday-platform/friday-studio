import { describe, expect, it } from "vitest";
import type { NarrativeEntry } from "../memory-adapter.ts";
import type { ScratchpadAdapter } from "../scratchpad-adapter.ts";

describe("ScratchpadAdapter type contracts", () => {
  it("promote() return type is NarrativeEntry", () => {
    type PromoteReturn = Awaited<ReturnType<ScratchpadAdapter["promote"]>>;
    const check: PromoteReturn extends NarrativeEntry ? true : false = true;
    expect(check).toBe(true);
  });

  it("promote() return type includes all NarrativeEntry fields", () => {
    const entry: Awaited<ReturnType<ScratchpadAdapter["promote"]>> = {
      id: "entry-1",
      text: "promoted chunk",
      createdAt: "2026-04-14T00:00:00Z",
    };
    expect(entry.id).toBe("entry-1");
    expect(entry.text).toBe("promoted chunk");
  });

  it("promote() return type accepts optional NarrativeEntry fields", () => {
    const entry: Awaited<ReturnType<ScratchpadAdapter["promote"]>> = {
      id: "entry-2",
      text: "promoted with metadata",
      author: "test-agent",
      createdAt: "2026-04-14T00:00:00Z",
      metadata: { source: "scratchpad" },
    };
    expect(entry.author).toBe("test-agent");
    expect(entry.metadata?.source).toBe("scratchpad");
  });
});
