import { describe, expect, it } from "vitest";
import {
  MemoryConfigSchema,
  MemoryOwnEntrySchema,
  MemoryStrategySchema,
  MemoryTypeSchema,
} from "../config-schema.ts";

describe("MemoryTypeSchema", () => {
  it("accepts short_term", () => {
    expect(MemoryTypeSchema.parse("short_term")).toBe("short_term");
  });

  it("accepts long_term", () => {
    expect(MemoryTypeSchema.parse("long_term")).toBe("long_term");
  });

  it("accepts scratchpad", () => {
    expect(MemoryTypeSchema.parse("scratchpad")).toBe("scratchpad");
  });

  it("rejects invalid values", () => {
    expect(() => MemoryTypeSchema.parse("permanent")).toThrow();
    expect(() => MemoryTypeSchema.parse("temporary")).toThrow();
    expect(() => MemoryTypeSchema.parse("")).toThrow();
  });
});

describe("MemoryStrategySchema", () => {
  it("accepts narrative", () => {
    expect(MemoryStrategySchema.parse("narrative")).toBe("narrative");
  });

  it("rejects retrieval/dedup/kv (removed in 2026-05 cleanup)", () => {
    for (const strategy of ["retrieval", "dedup", "kv"]) {
      expect(() => MemoryStrategySchema.parse(strategy)).toThrow();
    }
  });

  it("accepts undefined (optional)", () => {
    expect(MemoryStrategySchema.parse(undefined)).toBeUndefined();
  });
});

describe("MemoryOwnEntrySchema", () => {
  it("parses valid entry with type and strategy", () => {
    const result = MemoryOwnEntrySchema.parse({
      name: "notes",
      type: "long_term",
      strategy: "narrative",
    });
    expect(result).toEqual({ name: "notes", type: "long_term", strategy: "narrative" });
  });

  it("parses entry without strategy (optional)", () => {
    const result = MemoryOwnEntrySchema.parse({ name: "session-cache", type: "short_term" });
    expect(result.name).toBe("session-cache");
    expect(result.type).toBe("short_term");
    expect(result.strategy).toBeUndefined();
  });

  it("rejects entry with empty name", () => {
    expect(() => MemoryOwnEntrySchema.parse({ name: "", type: "long_term" })).toThrow();
  });

  it("rejects entry with invalid type", () => {
    expect(() => MemoryOwnEntrySchema.parse({ name: "notes", type: "permanent" })).toThrow();
  });
});

describe("MemoryConfigSchema.own", () => {
  it("accepts array of entries", () => {
    const result = MemoryConfigSchema.parse({
      own: [
        { name: "notes", type: "long_term", strategy: "narrative" },
        { name: "cache", type: "short_term" },
        { name: "scratch", type: "scratchpad" },
      ],
    });
    expect(result.own).toHaveLength(3);
    expect(result.own[0]?.name).toBe("notes");
    expect(result.own[1]?.type).toBe("short_term");
    expect(result.own[2]?.type).toBe("scratchpad");
  });

  it("defaults to empty array when omitted", () => {
    const result = MemoryConfigSchema.parse({});
    expect(result.own).toEqual([]);
  });

  it("defaults to empty array when explicitly undefined", () => {
    const result = MemoryConfigSchema.parse({ own: undefined });
    expect(result.own).toEqual([]);
  });

  it("coexists with mounts and shareable", () => {
    const result = MemoryConfigSchema.parse({
      own: [{ name: "notes", type: "long_term" }],
      mounts: [
        { name: "backlog", source: "_global/narrative/autopilot-backlog", scope: "workspace" },
      ],
      shareable: { list: ["notes"], allowedWorkspaces: ["*"] },
    });
    expect(result.own).toHaveLength(1);
    expect(result.mounts).toHaveLength(1);
    expect(result.shareable?.list).toEqual(["notes"]);
  });
});
