import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  MemoryAdapter,
  ScratchpadAdapter,
  ScratchpadChunk,
  SkillAdapter,
} from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { InspectDeps } from "../commands/inspect.ts";
import { inspectCommand } from "../commands/inspect.ts";

function unusedCorpus<K extends CorpusKind>(
  _workspaceId: string,
  _name: string,
  _kind: K,
): Promise<CorpusOf<K>> {
  throw new Error("not called in test");
}

function createDeps(overrides?: Partial<InspectDeps>): InspectDeps {
  return {
    memory: {
      corpus: unusedCorpus,
      list: vi.fn<(workspaceId: string) => Promise<CorpusMetadata[]>>().mockResolvedValue([]),
      bootstrap: vi
        .fn<(workspaceId: string, agentId: string) => Promise<string>>()
        .mockResolvedValue(""),
      history: vi.fn<MemoryAdapter["history"]>().mockResolvedValue([]),
      rollback: vi.fn<MemoryAdapter["rollback"]>().mockResolvedValue(undefined),
    },
    skills: {
      list: vi.fn<SkillAdapter["list"]>().mockResolvedValue([]),
      get: vi.fn<SkillAdapter["get"]>().mockResolvedValue(undefined),
      create: vi.fn<SkillAdapter["create"]>(),
      update: vi.fn<SkillAdapter["update"]>(),
      history: vi.fn<SkillAdapter["history"]>().mockResolvedValue([]),
      rollback: vi.fn<SkillAdapter["rollback"]>(),
      invalidate: vi.fn<SkillAdapter["invalidate"]>(),
    },
    scratchpad: {
      append: vi.fn<ScratchpadAdapter["append"]>(),
      read: vi.fn<ScratchpadAdapter["read"]>().mockResolvedValue([]),
      clear: vi.fn<ScratchpadAdapter["clear"]>(),
      promote: vi.fn<ScratchpadAdapter["promote"]>(),
    },
    ...overrides,
  };
}

describe("inspect --kind scratchpad", () => {
  it("sorts chunks chronologically", async () => {
    const chunks: ScratchpadChunk[] = [
      { id: "c2", kind: "thought", body: "second thought", createdAt: "2026-04-14T10:00:00Z" },
      { id: "c1", kind: "thought", body: "first thought", createdAt: "2026-04-14T09:00:00Z" },
      { id: "c3", kind: "plan", body: "final plan", createdAt: "2026-04-14T11:00:00Z" },
    ];
    const deps = createDeps({
      scratchpad: {
        append: vi.fn<ScratchpadAdapter["append"]>(),
        read: vi.fn<ScratchpadAdapter["read"]>().mockResolvedValue(chunks),
        clear: vi.fn<ScratchpadAdapter["clear"]>(),
        promote: vi.fn<ScratchpadAdapter["promote"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "scratchpad" });

    const lines = result.output.split("\n");
    const dataLines = lines.slice(2);
    const firstDataLine = dataLines[0] ?? "";
    const lastDataLine = dataLines[dataLines.length - 1] ?? "";
    expect(firstDataLine).toContain("c1");
    expect(lastDataLine).toContain("c3");
  });

  it("forwards --since filter to adapter", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "scratchpad", since: "2026-04-14T10:00:00Z" });

    expect(deps.scratchpad.read).toHaveBeenCalledWith("default", { since: "2026-04-14T10:00:00Z" });
  });

  it("uses session arg as sessionKey", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "scratchpad", session: "sess-abc" });

    expect(deps.scratchpad.read).toHaveBeenCalledWith("sess-abc", { since: undefined });
  });

  it("returns empty message when no chunks", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "scratchpad" });

    expect(result.output).toBe("No scratchpad chunks found.");
  });

  it("truncates long body text", async () => {
    const longBody = "A".repeat(100);
    const chunks: ScratchpadChunk[] = [
      { id: "c1", kind: "note", body: longBody, createdAt: "2026-04-14T09:00:00Z" },
    ];
    const deps = createDeps({
      scratchpad: {
        append: vi.fn<ScratchpadAdapter["append"]>(),
        read: vi.fn<ScratchpadAdapter["read"]>().mockResolvedValue(chunks),
        clear: vi.fn<ScratchpadAdapter["clear"]>(),
        promote: vi.fn<ScratchpadAdapter["promote"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "scratchpad" });

    expect(result.output).toContain("...");
    expect(result.output).not.toContain(longBody);
  });
});
