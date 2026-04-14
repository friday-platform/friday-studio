import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  MemoryAdapter,
  ScratchpadAdapter,
  SkillAdapter,
  SkillMetadata,
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

describe("inspect --kind skills", () => {
  it("renders three skills in table", async () => {
    const skills: SkillMetadata[] = [
      { name: "summarize", version: "1.0.0", description: "Summarizes text" },
      { name: "translate", version: "2.1.0", description: "Translates content" },
      { name: "classify", version: "0.3.0", description: "Classifies documents" },
    ];
    const deps = createDeps({
      skills: {
        list: vi.fn<SkillAdapter["list"]>().mockResolvedValue(skills),
        get: vi.fn<SkillAdapter["get"]>().mockResolvedValue(undefined),
        create: vi.fn<SkillAdapter["create"]>(),
        update: vi.fn<SkillAdapter["update"]>(),
        history: vi.fn<SkillAdapter["history"]>().mockResolvedValue([]),
        rollback: vi.fn<SkillAdapter["rollback"]>(),
        invalidate: vi.fn<SkillAdapter["invalidate"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "skills" });

    expect(result.output).toContain("summarize");
    expect(result.output).toContain("translate");
    expect(result.output).toContain("classify");
    expect(result.output).toContain("NAME");
    expect(result.output).toContain("VERSION");
  });

  it("outputs valid JSON array with --json flag", async () => {
    const skills: SkillMetadata[] = [
      { name: "summarize", version: "1.0.0", description: "Summarizes text" },
      { name: "translate", version: "2.1.0", description: "Translates content" },
      { name: "classify", version: "0.3.0", description: "Classifies documents" },
    ];
    const deps = createDeps({
      skills: {
        list: vi.fn<SkillAdapter["list"]>().mockResolvedValue(skills),
        get: vi.fn<SkillAdapter["get"]>().mockResolvedValue(undefined),
        create: vi.fn<SkillAdapter["create"]>(),
        update: vi.fn<SkillAdapter["update"]>(),
        history: vi.fn<SkillAdapter["history"]>().mockResolvedValue([]),
        rollback: vi.fn<SkillAdapter["rollback"]>(),
        invalidate: vi.fn<SkillAdapter["invalidate"]>(),
      },
    });

    const result = await inspectCommand(deps, { kind: "skills", json: true });

    const parsed = JSON.parse(result.output) as SkillMetadata[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.name).toBe("summarize");
    expect(parsed[1]?.name).toBe("translate");
    expect(parsed[2]?.name).toBe("classify");
  });

  it("returns empty message when no skills", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "skills" });

    expect(result.output).toBe("No skills found.");
  });
});
