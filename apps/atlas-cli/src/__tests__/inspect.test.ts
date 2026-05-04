import type {
  HistoryEntry,
  MemoryAdapter,
  NarrativeStore,
  ScratchpadAdapter,
  ScratchpadChunk,
  SkillAdapter,
  SkillMetadata,
  SkillVersion,
  StoreMetadata,
} from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { InspectDeps } from "../commands/inspect.ts";
import { inspectCommand } from "../commands/inspect.ts";

function unusedStore(_workspaceId: string, _name: string): Promise<NarrativeStore> {
  throw new Error("not called in test");
}

function createDeps(overrides?: Partial<InspectDeps>): InspectDeps {
  return {
    memory: {
      store: unusedStore,
      list: vi.fn<(workspaceId: string) => Promise<StoreMetadata[]>>().mockResolvedValue([]),
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
  it("renders table rows for two memories", async () => {
    const memories: StoreMetadata[] = [
      { name: "session-log", kind: "narrative", workspaceId: "ws-1" },
      { name: "docs-index", kind: "narrative", workspaceId: "ws-1" },
    ];
    const deps = createDeps({
      memory: {
        store: unusedStore,
        list: vi
          .fn<(workspaceId: string) => Promise<StoreMetadata[]>>()
          .mockResolvedValue(memories),
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
    expect(result.output).toContain("NAME");
    expect(result.output).toContain("KIND");
  });

  it("passes workspace to adapter", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "memory", workspace: "my-ws" });

    expect(deps.memory.list).toHaveBeenCalledWith("my-ws");
  });

  it("returns empty message when no memories", async () => {
    const deps = createDeps();
    const result = await inspectCommand(deps, { kind: "memory" });

    expect(result.output).toBe("No memories found.");
  });

  it("defaults workspace to 'default'", async () => {
    const deps = createDeps();
    await inspectCommand(deps, { kind: "memory" });

    expect(deps.memory.list).toHaveBeenCalledWith("default");
  });

  it("outputs JSON array with --json flag", async () => {
    const memories: StoreMetadata[] = [
      { name: "session-log", kind: "narrative", workspaceId: "ws-1" },
    ];
    const deps = createDeps({
      memory: {
        store: unusedStore,
        list: vi
          .fn<(workspaceId: string) => Promise<StoreMetadata[]>>()
          .mockResolvedValue(memories),
        bootstrap: vi
          .fn<(workspaceId: string, agentId: string) => Promise<string>>()
          .mockResolvedValue(""),
        history: vi.fn<MemoryAdapter["history"]>().mockResolvedValue([]),
        rollback: vi.fn<MemoryAdapter["rollback"]>().mockResolvedValue(undefined),
      },
    });

    const result = await inspectCommand(deps, { kind: "memory", json: true });

    const parsed = JSON.parse(result.output) as StoreMetadata[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.name).toBe("session-log");
  });
});

describe("inspect --kind memory --history", () => {
  it("renders memory version history", async () => {
    const entries: HistoryEntry[] = [
      { version: "v1", store: "session-log", at: "2026-04-14T08:00:00Z", summary: "Initial" },
      { version: "v2", store: "session-log", at: "2026-04-14T09:00:00Z", summary: "Updated" },
    ];
    const deps = createDeps({
      memory: {
        store: unusedStore,
        list: vi.fn<(workspaceId: string) => Promise<StoreMetadata[]>>().mockResolvedValue([]),
        bootstrap: vi
          .fn<(workspaceId: string, agentId: string) => Promise<string>>()
          .mockResolvedValue(""),
        history: vi.fn<MemoryAdapter["history"]>().mockResolvedValue(entries),
        rollback: vi.fn<MemoryAdapter["rollback"]>().mockResolvedValue(undefined),
      },
    });

    const result = await inspectCommand(deps, { kind: "memory", history: true });

    expect(result.output).toContain("VERSION");
    expect(result.output).toContain("MEMORY");
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
