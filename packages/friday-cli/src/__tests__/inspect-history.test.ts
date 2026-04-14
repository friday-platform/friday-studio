import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  HistoryEntry,
  MemoryAdapter,
  ScratchpadAdapter,
  SkillAdapter,
  SkillVersion,
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

describe("inspect --kind memory --history", () => {
  it("renders memory version history", async () => {
    const entries: HistoryEntry[] = [
      { version: "v1", corpus: "session-log", at: "2026-04-14T08:00:00Z", summary: "Initial" },
      { version: "v2", corpus: "session-log", at: "2026-04-14T09:00:00Z", summary: "Updated" },
    ];
    const deps = createDeps({
      memory: {
        corpus: unusedCorpus,
        list: vi.fn<(workspaceId: string) => Promise<CorpusMetadata[]>>().mockResolvedValue([]),
        bootstrap: vi
          .fn<(workspaceId: string, agentId: string) => Promise<string>>()
          .mockResolvedValue(""),
        history: vi.fn<MemoryAdapter["history"]>().mockResolvedValue(entries),
        rollback: vi.fn<MemoryAdapter["rollback"]>().mockResolvedValue(undefined),
      },
    });

    const result = await inspectCommand(deps, { kind: "memory", history: true });

    expect(result.output).toContain("VERSION");
    expect(result.output).toContain("CORPUS");
    expect(result.output).toContain("v1");
    expect(result.output).toContain("v2");
    expect(result.output).toContain("Initial");
    expect(result.output).toContain("Updated");
  });

  it("returns empty message when no history", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "memory", history: true });

    expect(result.output).toBe("No history entries found.");
  });
});

describe("inspect --kind skills --history", () => {
  it("renders skill version history", async () => {
    const versions: SkillVersion[] = [
      { version: "1.0.0", createdAt: "2026-04-14T08:00:00Z", summary: "Initial release" },
      { version: "1.1.0", createdAt: "2026-04-14T09:00:00Z", summary: "Bug fix" },
    ];
    const deps = createDeps({
      skills: {
        list: vi
          .fn<SkillAdapter["list"]>()
          .mockResolvedValue([
            { name: "summarize", version: "1.1.0", description: "Summarizes text" },
          ]),
        get: vi.fn<SkillAdapter["get"]>().mockResolvedValue(undefined),
        create: vi.fn<SkillAdapter["create"]>(),
        update: vi.fn<SkillAdapter["update"]>(),
        history: vi.fn<SkillAdapter["history"]>().mockResolvedValue(versions),
        rollback: vi.fn<SkillAdapter["rollback"]>(),
        invalidate: vi.fn<SkillAdapter["invalidate"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "skills", history: true });

    expect(result.output).toContain("SKILL");
    expect(result.output).toContain("VERSION");
    expect(result.output).toContain("summarize");
    expect(result.output).toContain("1.0.0");
    expect(result.output).toContain("1.1.0");
    expect(result.output).toContain("Initial release");
    expect(result.output).toContain("Bug fix");
  });

  it("returns empty message when no skill versions", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "skills", history: true });

    expect(result.output).toBe("No skill versions found.");
  });

  it("renders skill history as JSON with --json", async () => {
    const versions: SkillVersion[] = [
      { version: "1.0.0", createdAt: "2026-04-14T08:00:00Z", summary: "Initial" },
    ];
    const deps = createDeps({
      skills: {
        list: vi
          .fn<SkillAdapter["list"]>()
          .mockResolvedValue([{ name: "test-skill", version: "1.0.0", description: "Test" }]),
        get: vi.fn<SkillAdapter["get"]>().mockResolvedValue(undefined),
        create: vi.fn<SkillAdapter["create"]>(),
        update: vi.fn<SkillAdapter["update"]>(),
        history: vi.fn<SkillAdapter["history"]>().mockResolvedValue(versions),
        rollback: vi.fn<SkillAdapter["rollback"]>(),
        invalidate: vi.fn<SkillAdapter["invalidate"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "skills", history: true, json: true });

    const parsed = JSON.parse(result.output) as Array<SkillVersion & { skill: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.skill).toBe("test-skill");
    expect(parsed[0]?.version).toBe("1.0.0");
  });
});
