import type {
  AgentContext,
  AgentMemoryContext,
  CorpusMountBinding,
  MemoryAdapter,
  NarrativeEntry,
} from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { MountedCorpusBinding } from "../mounted-corpus-binding.ts";

const ENTRY: NarrativeEntry = { id: "e-1", text: "hello", createdAt: "2026-04-14T00:00:00Z" };

function buildMockContext(): AgentContext {
  const binding = new MountedCorpusBinding({
    name: "backlog",
    source: "_global/narrative/autopilot-backlog",
    mode: "rw",
    scope: "workspace",
    read: vi.fn<() => Promise<NarrativeEntry[]>>().mockResolvedValue([ENTRY]),
    append: vi
      .fn<(e: NarrativeEntry) => Promise<NarrativeEntry>>()
      .mockImplementation((e) => Promise.resolve(e)),
  });

  const memory: AgentMemoryContext = { mounts: { backlog: binding } };

  return {
    tools: {} as AgentContext["tools"],
    session: {
      sessionId: "s-1",
      workspaceId: "ws-1",
      userId: "u-1",
      datetime: {
        timezone: "UTC",
        timestamp: "2026-04-14T00:00:00Z",
        localDate: "2026-04-14",
        localTime: "00:00:00",
        timezoneOffset: "+00:00",
      },
    },
    env: {},
    stream: undefined,
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as AgentContext["logger"],
    memory,
  };
}

describe("ctx.memory.mounts[name]", () => {
  it("is accessible as CorpusMountBinding after runtime start", () => {
    const ctx = buildMockContext();

    const mount: CorpusMountBinding | undefined = ctx.memory?.mounts["backlog"];
    expect(mount).toBeDefined();
    expect(mount?.name).toBe("backlog");
    expect(mount?.mode).toBe("rw");
    expect(mount?.scope).toBe("workspace");
  });

  it("read() returns entries through the binding", async () => {
    const ctx = buildMockContext();
    const mount = ctx.memory?.mounts["backlog"];

    const entries = await mount?.read();
    expect(entries).toEqual([ENTRY]);
  });

  it("append() returns the appended entry through the binding", async () => {
    const ctx = buildMockContext();
    const mount = ctx.memory?.mounts["backlog"];

    const result = await mount?.append(ENTRY);
    expect(result).toEqual(ENTRY);
  });

  it("MountedCorpusBinding satisfies CorpusMountBinding interface", () => {
    const binding = new MountedCorpusBinding({
      name: "test",
      source: "ws/narrative/corpus",
      mode: "ro",
      scope: "agent",
      scopeTarget: "planner",
      read: vi.fn<() => Promise<NarrativeEntry[]>>(),
      append: vi.fn<(e: NarrativeEntry) => Promise<NarrativeEntry>>(),
    });

    const asInterface: CorpusMountBinding = binding;
    expect(asInterface.name).toBe("test");
    expect(asInterface.source).toBe("ws/narrative/corpus");
    expect(asInterface.mode).toBe("ro");
    expect(asInterface.scope).toBe("agent");
    expect(asInterface.scopeTarget).toBe("planner");
  });

  it("adapter and scratchpad are optional on AgentMemoryContext", () => {
    const memory: AgentMemoryContext = { mounts: {} };
    expect(memory.adapter).toBeUndefined();
    expect(memory.scratchpad).toBeUndefined();
  });

  it("adapter can be provided on AgentMemoryContext", () => {
    const adapter: MemoryAdapter = {
      corpus: vi.fn(),
      list: vi.fn(),
      bootstrap: vi.fn(),
      history: vi.fn(),
      rollback: vi.fn(),
    };
    const memory: AgentMemoryContext = { mounts: {}, adapter };
    expect(memory.adapter).toBe(adapter);
  });
});
