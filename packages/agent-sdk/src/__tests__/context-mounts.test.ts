import { describe, expect, it } from "vitest";
import type {
  AgentContext,
  AgentMemoryContext,
  CorpusMountBinding,
  NarrativeEntry,
} from "../index.ts";

describe("AgentContext.memory.mounts type", () => {
  it("accepts a Record<string, CorpusMountBinding>", () => {
    const binding: CorpusMountBinding = {
      name: "backlog",
      source: "_global/narrative/backlog",
      mode: "ro",
      scope: "workspace",
      read: () => Promise.resolve([]),
      append: (_entry: NarrativeEntry) =>
        Promise.resolve({ id: "1", text: "t", createdAt: "2026-01-01T00:00:00Z" }),
    };

    const memory: AgentMemoryContext = { mounts: { backlog: binding } };

    const context: Partial<AgentContext> = { memory };

    expect(context.memory?.mounts.backlog).toBeDefined();
    expect(context.memory?.mounts.backlog?.name).toBe("backlog");
    expect(context.memory?.mounts.backlog?.mode).toBe("ro");
  });

  it("accepts an empty mounts record", () => {
    const memory: AgentMemoryContext = { mounts: {} };
    const context: Partial<AgentContext> = { memory };
    expect(Object.keys(context.memory?.mounts ?? {})).toHaveLength(0);
  });

  it("AgentContext without memory is valid (field is optional)", () => {
    const context: Partial<AgentContext> = { env: {} };
    expect(context.memory).toBeUndefined();
  });
});
