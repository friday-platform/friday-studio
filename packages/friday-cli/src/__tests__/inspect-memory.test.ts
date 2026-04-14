import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  MemoryAdapter,
  ScratchpadAdapter,
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

describe("inspect --kind memory", () => {
  it("renders table rows for two corpora", async () => {
    const corpora: CorpusMetadata[] = [
      { name: "session-log", kind: "narrative", workspaceId: "ws-1" },
      { name: "docs-index", kind: "retrieval", workspaceId: "ws-1" },
    ];
    const deps = createDeps({
      memory: {
        corpus: unusedCorpus,
        list: vi
          .fn<(workspaceId: string) => Promise<CorpusMetadata[]>>()
          .mockResolvedValue(corpora),
        bootstrap: vi
          .fn<(workspaceId: string, agentId: string) => Promise<string>>()
          .mockResolvedValue(""),
        history: vi.fn<MemoryAdapter["history"]>().mockResolvedValue([]),
        rollback: vi.fn<MemoryAdapter["rollback"]>().mockResolvedValue(undefined),
      },
    });

    const result = await inspectCommand(deps, { kind: "memory" });

    expect(result.output).toContain("session-log");
    expect(result.output).toContain("narrative");
    expect(result.output).toContain("docs-index");
    expect(result.output).toContain("retrieval");
    expect(result.output).toContain("NAME");
    expect(result.output).toContain("KIND");
  });

  it("passes workspace to adapter", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "memory", workspace: "my-ws" });

    expect(deps.memory.list).toHaveBeenCalledWith("my-ws");
  });

  it("returns empty message when no corpora", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "memory" });

    expect(result.output).toBe("No corpora found.");
  });

  it("defaults workspace to 'default'", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "memory" });

    expect(deps.memory.list).toHaveBeenCalledWith("default");
  });
});
