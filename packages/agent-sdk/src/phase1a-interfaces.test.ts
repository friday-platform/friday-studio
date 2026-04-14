import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HistoryEntrySchema, NarrativeEntrySchema } from "./memory-adapter.ts";
import { AtlasDataEventSchema } from "./messages.ts";
import { withSchemaBoundary } from "./schema-boundary.ts";
import { ScratchpadChunkSchema } from "./scratchpad-adapter.ts";
import { SkillDraftSchema } from "./skill-adapter.ts";

// ── withSchemaBoundary ──────────────────────────────────────────────────────

describe("withSchemaBoundary", () => {
  const TestSchema = z.object({ name: z.string(), count: z.number() });

  it("resolves when input matches schema; commit receives parsed value, onCommit receives result", async () => {
    const commit = vi
      .fn<(parsed: { name: string; count: number }) => Promise<string>>()
      .mockResolvedValue("committed");
    const onCommit = vi.fn<(result: string) => void>();

    const result = await withSchemaBoundary(
      { schema: TestSchema, commit, onCommit },
      { name: "test", count: 42 },
    );

    expect(result).toBe("committed");
    expect(commit).toHaveBeenCalledWith({ name: "test", count: 42 });
    expect(onCommit).toHaveBeenCalledWith("committed");
  });

  it("throws ZodError before calling commit when input fails schema validation", async () => {
    const commit = vi.fn<() => Promise<string>>();

    await expect(withSchemaBoundary({ schema: TestSchema, commit }, { name: 123 })).rejects.toThrow(
      z.ZodError,
    );

    expect(commit).not.toHaveBeenCalled();
  });

  it("resolves even when onCommit is undefined", async () => {
    const commit = vi
      .fn<(parsed: { name: string; count: number }) => Promise<string>>()
      .mockResolvedValue("ok");

    const result = await withSchemaBoundary(
      { schema: TestSchema, commit },
      { name: "hello", count: 1 },
    );

    expect(result).toBe("ok");
  });
});

// ── NarrativeEntrySchema ────────────────────────────────────────────────────

describe("NarrativeEntrySchema", () => {
  it("rejects object missing required id/text/createdAt fields", () => {
    const result = NarrativeEntrySchema.safeParse({ author: "alice" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid NarrativeEntry", () => {
    const result = NarrativeEntrySchema.safeParse({
      id: "n-1",
      text: "hello world",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// ── ScratchpadChunkSchema ───────────────────────────────────────────────────

describe("ScratchpadChunkSchema", () => {
  it("round-trips a valid ScratchpadChunk", () => {
    const chunk = {
      id: "sc-1",
      kind: "reasoning",
      body: "thinking about X",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const result = ScratchpadChunkSchema.parse(chunk);
    expect(result).toEqual(chunk);
  });
});

// ── SkillDraftSchema ────────────────────────────────────────────────────────

describe("SkillDraftSchema", () => {
  it("rejects missing description field", () => {
    const result = SkillDraftSchema.safeParse({ name: "my-skill", instructions: "do stuff" });
    expect(result.success).toBe(false);
  });
});

// ── AtlasDataEventSchema ────────────────────────────────────────────────────

describe("AtlasDataEventSchema", () => {
  it("correctly discriminates memory-write event", () => {
    const event = {
      type: "memory-write" as const,
      workspaceId: "ws-1",
      corpus: "notes",
      entryId: "e-1",
      kind: "narrative" as const,
      at: "2026-01-01T00:00:00Z",
    };
    const result = AtlasDataEventSchema.parse(event);
    expect(result.type).toBe("memory-write");
  });

  it("correctly discriminates memory-rollback event", () => {
    const event = {
      type: "memory-rollback" as const,
      workspaceId: "ws-1",
      corpus: "notes",
      toVersion: "v2",
      at: "2026-01-01T00:00:00Z",
    };
    const result = AtlasDataEventSchema.parse(event);
    expect(result.type).toBe("memory-rollback");
  });

  it("correctly discriminates scratchpad-write event", () => {
    const event = {
      type: "scratchpad-write" as const,
      sessionKey: "sess-1",
      chunkId: "ch-1",
      kind: "reasoning",
      at: "2026-01-01T00:00:00Z",
    };
    const result = AtlasDataEventSchema.parse(event);
    expect(result.type).toBe("scratchpad-write");
  });

  it("correctly discriminates skill-write event", () => {
    const event = {
      type: "skill-write" as const,
      workspaceId: "ws-1",
      name: "summarize",
      version: "v1",
      at: "2026-01-01T00:00:00Z",
    };
    const result = AtlasDataEventSchema.parse(event);
    expect(result.type).toBe("skill-write");
  });

  it("correctly discriminates skill-rollback event", () => {
    const event = {
      type: "skill-rollback" as const,
      workspaceId: "ws-1",
      name: "summarize",
      toVersion: "v0",
      at: "2026-01-01T00:00:00Z",
    };
    const result = AtlasDataEventSchema.parse(event);
    expect(result.type).toBe("skill-rollback");
  });

  it("rejects unknown event type discriminant", () => {
    const result = AtlasDataEventSchema.safeParse({ type: "unknown-event", workspaceId: "ws-1" });
    expect(result.success).toBe(false);
  });
});

// ── HistoryEntrySchema ──────────────────────────────────────────────────────

describe("HistoryEntrySchema", () => {
  it("rejects objects missing version/at/summary", () => {
    const result = HistoryEntrySchema.safeParse({ corpus: "notes" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid HistoryEntry", () => {
    const result = HistoryEntrySchema.safeParse({
      version: "v1",
      corpus: "notes",
      at: "2026-01-01T00:00:00Z",
      summary: "initial commit",
    });
    expect(result.success).toBe(true);
  });
});
