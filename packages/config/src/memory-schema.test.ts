import { describe, expect, it } from "vitest";
import {
  MemoryMountSourceSchema,
  MemoryOwnEntrySchema,
  MemoryTypeSchema,
  MountFilterSchema,
  WorkspaceConfigSchema,
} from "./workspace.ts";

const minimalWorkspace = {
  version: "1.0" as const,
  workspace: { name: "test", description: "test workspace" },
};

function validMount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "backlog",
    source: "_global/narrative/autopilot-backlog",
    scope: "workspace",
    ...overrides,
  };
}

describe("MemoryTypeSchema", () => {
  it.each(["short_term", "long_term", "scratchpad"] as const)("accepts type %s", (type) => {
    expect(MemoryTypeSchema.parse(type)).toBe(type);
  });

  it("rejects invalid type", () => {
    expect(() => MemoryTypeSchema.parse("ephemeral")).toThrow();
  });
});

describe("MemoryOwnEntrySchema", () => {
  it("accepts entry with optional strategy", () => {
    const entry = MemoryOwnEntrySchema.parse({
      name: "notes",
      type: "long_term",
      strategy: "narrative",
    });
    expect(entry.name).toBe("notes");
    expect(entry.type).toBe("long_term");
    expect(entry.strategy).toBe("narrative");
  });

  it("strategy is optional", () => {
    const entry = MemoryOwnEntrySchema.parse({ name: "scratch", type: "scratchpad" });
    expect(entry.strategy).toBeUndefined();
  });

  it("accepts strategy narrative", () => {
    const entry = MemoryOwnEntrySchema.parse({
      name: "test",
      type: "long_term",
      strategy: "narrative",
    });
    expect(entry.strategy).toBe("narrative");
  });

  it.each([
    "retrieval",
    "dedup",
    "kv",
  ] as const)("rejects %s strategy (removed in 2026-05 cleanup)", (strategy) => {
    expect(() =>
      MemoryOwnEntrySchema.parse({ name: "test", type: "long_term", strategy }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => MemoryOwnEntrySchema.parse({ name: "", type: "long_term" })).toThrow();
  });
});

describe("WorkspaceConfigSchema memory", () => {
  it("rejects legacy corpus_mounts field", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      corpus_mounts: [{ workspace: "ws", corpus: "c", kind: "narrative", mode: "read" }],
    });
    expect(result.success).toBe(false);
  });

  it("parses memory.mounts with valid 3-segment source", () => {
    const result = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      memory: {
        mounts: [
          {
            name: "reflections",
            source: "thick_endive/narrative/reflections",
            mode: "ro",
            scope: "workspace",
            filter: { kind: "narrative" },
          },
        ],
      },
    });
    const mount = result.memory?.mounts[0];
    expect(mount).toBeDefined();
    expect(mount?.name).toBe("reflections");
    expect(mount?.source).toBe("thick_endive/narrative/reflections");
    expect(mount?.scope).toBe("workspace");
  });

  it("parses memory.shareable.list (renamed from corpora)", () => {
    const result = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      memory: {
        shareable: { list: ["notes", "reflections"], allowedWorkspaces: ["thick_endive"] },
      },
    });
    expect(result.memory?.shareable?.list).toEqual(["notes", "reflections"]);
  });

  it("shareable.corpora is stripped (old field name, z.object strips unknown keys)", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { shareable: { corpora: ["notes"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory?.shareable?.list).toBeUndefined();
      expect(
        (result.data.memory?.shareable as Record<string, unknown> | undefined)?.["corpora"],
      ).toBeUndefined();
    }
  });

  it("full round-trip: memory.own + memory.mounts + memory.shareable.list", () => {
    const config = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      memory: {
        own: [
          { name: "notes", type: "long_term", strategy: "narrative" },
          { name: "cache", type: "short_term" },
          { name: "pad", type: "scratchpad" },
        ],
        mounts: [
          {
            name: "shared-backlog",
            source: "thick_endive/narrative/notes",
            mode: "ro",
            scope: "workspace",
          },
        ],
        shareable: { list: ["notes"], allowedWorkspaces: ["thick_endive"] },
      },
    });

    expect(config.memory?.own).toHaveLength(3);
    expect(config.memory?.own[0]?.type).toBe("long_term");
    expect(config.memory?.own[1]?.strategy).toBeUndefined();
    expect(config.memory?.mounts).toHaveLength(1);
    expect(config.memory?.shareable?.list).toEqual(["notes"]);
  });
});

describe("WorkspaceConfigSchema strict mount validation", () => {
  it("rejects source with invalid format 'bad//corpus'", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ source: "bad//corpus" })] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects source with unknown kind 'ws/unknown/corpus'", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ source: "ws/unknown/corpus" })] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid 3-segment source 'thick_endive/narrative/autopilot-backlog'", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ source: "thick_endive/narrative/autopilot-backlog" })] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects scope='job' without scopeTarget", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ scope: "job" })] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects scope='agent' without scopeTarget", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ scope: "agent" })] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts scope='workspace' without scopeTarget", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      memory: { mounts: [validMount({ scope: "workspace" })] },
    });
    expect(result.success).toBe(true);
  });

  it("mode defaults to 'ro' when omitted", () => {
    const result = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      memory: { mounts: [validMount()] },
    });
    expect(result.memory?.mounts[0]?.mode).toBe("ro");
  });
});

describe("MemoryMountSourceSchema", () => {
  it("rejects 2-segment source (missing kind)", () => {
    expect(() => MemoryMountSourceSchema.parse("thick_endive/reflections")).toThrow();
  });

  it("accepts _global/narrative/shared-flags", () => {
    expect(MemoryMountSourceSchema.parse("_global/narrative/shared-flags")).toBe(
      "_global/narrative/shared-flags",
    );
  });

  it("rejects retrieval/dedup/kv kinds (removed in 2026-05 cleanup)", () => {
    for (const kind of ["retrieval", "dedup", "kv"]) {
      expect(() => MemoryMountSourceSchema.parse(`ws/${kind}/store`)).toThrow();
    }
  });
});

describe("MountFilterSchema", () => {
  it("rejects non-ISO since string", () => {
    expect(() => MountFilterSchema.parse({ since: "not-a-date" })).toThrow();
  });

  it("accepts priority_min integer", () => {
    const result = MountFilterSchema.parse({ priority_min: 3 });
    expect(result.priority_min).toBe(3);
  });

  it("accepts status as string or string[]", () => {
    expect(MountFilterSchema.parse({ status: "open" }).status).toBe("open");
    expect(MountFilterSchema.parse({ status: ["open", "closed"] }).status).toEqual([
      "open",
      "closed",
    ]);
  });
});
