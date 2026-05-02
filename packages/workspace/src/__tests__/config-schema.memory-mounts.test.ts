import { describe, expect, it } from "vitest";
import {
  type MemoryConfig,
  MemoryConfigSchema,
  type MemoryMount,
  MemoryMountSchema,
  MemoryMountSourceSchema,
  MemoryOwnEntrySchema,
  MemoryStrategySchema,
  MemoryTypeSchema,
  parseMemoryMountSource,
  StoreKindSchema,
} from "../config-schema.ts";

function validMount(overrides: Partial<MemoryMount> = {}): Record<string, unknown> {
  return {
    name: "backlog",
    source: "_global/narrative/autopilot-backlog",
    scope: "workspace",
    ...overrides,
  };
}

describe("MemoryMountSchema", () => {
  describe("source validation", () => {
    it("accepts _global/narrative/autopilot-backlog", () => {
      const result = MemoryMountSchema.parse(validMount());
      expect(result.source).toBe("_global/narrative/autopilot-backlog");
    });

    it("accepts thick_endive/narrative/autopilot-backlog", () => {
      const result = MemoryMountSchema.parse(
        validMount({ source: "thick_endive/narrative/autopilot-backlog" }),
      );
      expect(result.source).toBe("thick_endive/narrative/autopilot-backlog");
    });

    it("accepts _global/narrative/shared-flags", () => {
      const result = MemoryMountSchema.parse(
        validMount({ source: "_global/narrative/shared-flags" }),
      );
      expect(result.source).toBe("_global/narrative/shared-flags");
    });

    it("accepts narrative kind", () => {
      const result = MemoryMountSchema.parse(validMount({ source: `ws_1/narrative/corpus-name` }));
      expect(result.source).toBe(`ws_1/narrative/corpus-name`);
    });

    it("rejects invalid kind e.g. ws/unknown/corpus", () => {
      expect(() => MemoryMountSchema.parse(validMount({ source: "ws/unknown/corpus" }))).toThrow();
    });

    it("rejects retrieval, dedup, kv kinds (removed in 2026-05 cleanup)", () => {
      for (const kind of ["retrieval", "dedup", "kv"]) {
        expect(() => MemoryMountSourceSchema.parse(`ws/${kind}/corpus`)).toThrow();
      }
    });

    it("rejects 'bad//corpus'", () => {
      expect(() => MemoryMountSourceSchema.parse("bad//corpus")).toThrow();
    });

    it("rejects source missing store name", () => {
      expect(() => MemoryMountSchema.parse(validMount({ source: "ws/narrative/" }))).toThrow();
    });

    it("rejects source with extra segments", () => {
      expect(() =>
        MemoryMountSchema.parse(validMount({ source: "ws/narrative/corpus/extra" })),
      ).toThrow();
    });

    it("rejects empty source", () => {
      expect(() => MemoryMountSchema.parse(validMount({ source: "" }))).toThrow();
    });
  });

  describe("mode", () => {
    it("defaults to 'ro' when omitted", () => {
      const result = MemoryMountSchema.parse(validMount());
      expect(result.mode).toBe("ro");
    });

    it("accepts 'rw' without error", () => {
      const result = MemoryMountSchema.parse(validMount({ mode: "rw" }));
      expect(result.mode).toBe("rw");
    });

    it("accepts 'ro' explicitly", () => {
      const result = MemoryMountSchema.parse(validMount({ mode: "ro" }));
      expect(result.mode).toBe("ro");
    });

    it("rejects invalid mode", () => {
      expect(() => MemoryMountSchema.parse(validMount({ mode: "rw+" as "rw" }))).toThrow();
    });
  });

  describe("scopeTarget enforcement", () => {
    it("scope='workspace' with no scopeTarget accepts", () => {
      const result = MemoryMountSchema.parse(validMount({ scope: "workspace" }));
      expect(result.scope).toBe("workspace");
      expect(result.scopeTarget).toBeUndefined();
    });

    it("scope='job' with scopeTarget set parses successfully", () => {
      const result = MemoryMountSchema.parse(
        validMount({ scope: "job", scopeTarget: "process-signals" }),
      );
      expect(result.scope).toBe("job");
      expect(result.scopeTarget).toBe("process-signals");
    });

    it("scope='job' with no scopeTarget rejects", () => {
      expect(() => MemoryMountSchema.parse(validMount({ scope: "job" }))).toThrow(/scopeTarget/);
    });

    it("scope='agent' with missing scopeTarget is rejected with descriptive ZodError", () => {
      const result = MemoryMountSchema.safeParse(validMount({ scope: "agent" }));
      expect(result.success).toBe(false);
      if (!result.success) {
        const scopeTargetIssue = result.error.issues.find((issue) =>
          issue.path.includes("scopeTarget"),
        );
        expect(scopeTargetIssue).toBeDefined();
        expect(scopeTargetIssue?.message).toContain("agent");
      }
    });

    it("scope='agent' with scopeTarget='agent-123' accepts", () => {
      const result = MemoryMountSchema.parse(
        validMount({ scope: "agent", scopeTarget: "agent-123" }),
      );
      expect(result.scopeTarget).toBe("agent-123");
    });

    it("scope='job' with empty scopeTarget rejects", () => {
      expect(() => MemoryMountSchema.parse(validMount({ scope: "job", scopeTarget: "" }))).toThrow(
        /scopeTarget/,
      );
    });
  });

  describe("filter", () => {
    it("accepts valid filter with since as ISO datetime", () => {
      const result = MemoryMountSchema.parse(
        validMount({ filter: { since: "2026-01-01T00:00:00Z" } }),
      );
      expect(result.filter?.since).toBe("2026-01-01T00:00:00Z");
    });

    it("accepts since with timezone offset", () => {
      const result = MemoryMountSchema.parse(
        validMount({ filter: { since: "2026-01-01T00:00:00+05:00" } }),
      );
      expect(result.filter?.since).toBe("2026-01-01T00:00:00+05:00");
    });

    it("rejects filter.since with a non-ISO string", () => {
      expect(() =>
        MemoryMountSchema.parse(validMount({ filter: { since: "not-a-date" } })),
      ).toThrow();
    });

    it("rejects filter.since bare date '2026-01-01' (no time component)", () => {
      expect(() =>
        MemoryMountSchema.parse(validMount({ filter: { since: "2026-01-01" } })),
      ).toThrow();
    });

    it("accepts filter with status string", () => {
      const result = MemoryMountSchema.parse(validMount({ filter: { status: "open" } }));
      expect(result.filter?.status).toBe("open");
    });

    it("accepts filter with status array", () => {
      const result = MemoryMountSchema.parse(
        validMount({ filter: { status: ["open", "in_progress"] } }),
      );
      expect(result.filter?.status).toEqual(["open", "in_progress"]);
    });

    it("accepts filter with priority_min integer", () => {
      const result = MemoryMountSchema.parse(validMount({ filter: { priority_min: 3 } }));
      expect(result.filter?.priority_min).toBe(3);
    });

    it("accepts filter with kind string scalar", () => {
      const result = MemoryMountSchema.parse(validMount({ filter: { kind: "task" } }));
      expect(result.filter?.kind).toBe("task");
    });

    it("accepts filter with kind string array", () => {
      const result = MemoryMountSchema.parse(validMount({ filter: { kind: ["task", "note"] } }));
      expect(result.filter?.kind).toEqual(["task", "note"]);
    });

    it("accepts undefined filter", () => {
      const result = MemoryMountSchema.parse(validMount());
      expect(result.filter).toBeUndefined();
    });
  });

  describe("required fields", () => {
    it("rejects missing name", () => {
      const { name: _, ...noName } = validMount();
      expect(() => MemoryMountSchema.parse(noName)).toThrow();
    });

    it("rejects empty name", () => {
      expect(() => MemoryMountSchema.parse(validMount({ name: "" }))).toThrow();
    });

    it("rejects missing source", () => {
      const { source: _, ...noSource } = validMount();
      expect(() => MemoryMountSchema.parse(noSource)).toThrow();
    });

    it("rejects missing scope", () => {
      const { scope: _, ...noScope } = validMount();
      expect(() => MemoryMountSchema.parse(noScope)).toThrow();
    });
  });
});

describe("MemoryConfigSchema", () => {
  it("mounts defaults to [] when memory key is omitted", () => {
    const result: MemoryConfig = MemoryConfigSchema.parse({});
    expect(result.mounts).toEqual([]);
    expect(result.shareable).toBeUndefined();
  });

  it("Integration: accepts full config with mounts array — mode defaults to 'ro'", () => {
    const result = MemoryConfigSchema.parse({
      mounts: [
        { name: "backlog", source: "_global/narrative/autopilot-backlog", scope: "workspace" },
      ],
    });
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]?.mode).toBe("ro");
  });

  it("Integration: memory.shareable allow-list parses alongside mounts", () => {
    const result = MemoryConfigSchema.parse({
      shareable: { list: ["autopilot-backlog"], allowedWorkspaces: ["ws-abc"] },
      mounts: [validMount()],
    });
    expect(result.mounts).toHaveLength(1);
    expect(result.shareable?.list).toEqual(["autopilot-backlog"]);
    expect(result.shareable?.allowedWorkspaces).toEqual(["ws-abc"]);
  });

  it("memory.shareable.allowedWorkspaces list parses as string array", () => {
    const result = MemoryConfigSchema.parse({
      shareable: { allowedWorkspaces: ["ws-1", "ws-2", "ws-3"] },
    });
    expect(result.shareable?.allowedWorkspaces).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("shareable with list entries and wildcard allowedWorkspaces parses", () => {
    const result = MemoryConfigSchema.parse({
      shareable: { list: ["shared-corpus", "limited-corpus"], allowedWorkspaces: ["*"] },
    });
    expect(result.shareable?.list).toEqual(["shared-corpus", "limited-corpus"]);
    expect(result.shareable?.allowedWorkspaces).toEqual(["*"]);
  });
});

describe("StoreKindSchema", () => {
  it("accepts narrative", () => {
    expect(StoreKindSchema.parse("narrative")).toBe("narrative");
  });

  it("rejects retrieval/dedup/kv (removed in 2026-05 cleanup)", () => {
    for (const kind of ["retrieval", "dedup", "kv"]) {
      expect(() => StoreKindSchema.parse(kind)).toThrow();
    }
  });

  it("rejects unknown kind", () => {
    expect(() => StoreKindSchema.parse("vector")).toThrow();
  });
});

describe("parseMemoryMountSource", () => {
  it("parses a valid source string into parts", () => {
    const result = parseMemoryMountSource("thick_endive/narrative/autopilot-backlog");
    expect(result.workspaceId).toBe("thick_endive");
    expect(result.kind).toBe("narrative");
    expect(result.memoryName).toBe("autopilot-backlog");
  });

  it("parses _global source", () => {
    const result = parseMemoryMountSource("_global/narrative/shared-flags");
    expect(result.workspaceId).toBe("_global");
    expect(result.kind).toBe("narrative");
    expect(result.memoryName).toBe("shared-flags");
  });

  it("throws on invalid source string", () => {
    expect(() => parseMemoryMountSource("bad//corpus")).toThrow();
  });
});

describe("MemoryTypeSchema", () => {
  it.each(["short_term", "long_term", "scratchpad"] as const)("accepts %s", (type) => {
    expect(MemoryTypeSchema.parse(type)).toBe(type);
  });

  it("rejects invalid type", () => {
    expect(() => MemoryTypeSchema.parse("ephemeral")).toThrow();
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

  it("rejects invalid strategy", () => {
    expect(() => MemoryStrategySchema.parse("vector")).toThrow();
  });
});

describe("MemoryOwnEntrySchema", () => {
  it("accepts entry with type and optional strategy", () => {
    const result = MemoryOwnEntrySchema.parse({ name: "notes", type: "long_term" });
    expect(result.name).toBe("notes");
    expect(result.type).toBe("long_term");
    expect(result.strategy).toBeUndefined();
  });

  it("accepts entry with strategy", () => {
    const result = MemoryOwnEntrySchema.parse({
      name: "vocab",
      type: "long_term",
      strategy: "narrative",
    });
    expect(result.strategy).toBe("narrative");
  });

  it("rejects empty name", () => {
    expect(() => MemoryOwnEntrySchema.parse({ name: "", type: "long_term" })).toThrow();
  });

  it("rejects invalid type", () => {
    expect(() => MemoryOwnEntrySchema.parse({ name: "x", type: "invalid" })).toThrow();
  });
});

describe("MemoryConfigSchema — own field", () => {
  it("own defaults to [] when omitted", () => {
    const result = MemoryConfigSchema.parse({});
    expect(result.own).toEqual([]);
  });

  it("accepts own entries alongside mounts and shareable.list", () => {
    const result = MemoryConfigSchema.parse({
      own: [{ name: "notes", type: "long_term", strategy: "narrative" }],
      mounts: [validMount()],
      shareable: { list: ["notes"], allowedWorkspaces: ["ws-1"] },
    });
    expect(result.own).toHaveLength(1);
    expect(result.mounts).toHaveLength(1);
    expect(result.shareable?.list).toEqual(["notes"]);
  });
});
