import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult, NarrativeStore } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock AgentOrchestrator — captures the prompt arg passed to executeAgent
// ---------------------------------------------------------------------------

const capturedPrompts = vi.hoisted(() => [] as string[]);
const mockStoreFn = vi.hoisted(() =>
  vi.fn<(wsId: string, name: string, kind: string) => Promise<NarrativeStore>>(),
);

vi.mock("@atlas/core", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/core")>();

  const successResult: AgentResult = {
    agentId: "test-agent",
    timestamp: new Date().toISOString(),
    input: {},
    ok: true as const,
    data: "mock agent output",
    durationMs: 0,
  };

  class MockAgentOrchestrator {
    executeAgent(_agentId: string, prompt: string): Promise<AgentResult> {
      capturedPrompts.push(prompt);
      return Promise.resolve(successResult);
    }
    hasActiveExecutions() {
      return false;
    }
    getActiveExecutions() {
      return [];
    }
    shutdown() {
      return Promise.resolve();
    }
  }

  return { ...actual, AgentOrchestrator: MockAgentOrchestrator };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNarrativeMock(content: string): NarrativeStore {
  return {
    append: (entry) => Promise.resolve(entry),
    read: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    forget: () => Promise.resolve(),
    render: () => Promise.resolve(content),
  };
}

function createAgentConfig(opts?: {
  memoryMounts?: MergedConfig["workspace"]["memory"];
}): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test-workspace", description: "Test workspace" },
      signals: {
        "test-signal": { provider: "http", description: "Test signal", config: { path: "/test" } },
      },
      jobs: {
        "test-job": {
          triggers: [{ signal: "test-signal" }],
          fsm: {
            id: "test-fsm",
            initial: "idle",
            states: {
              idle: { on: { "test-signal": { target: "step_work" } } },
              step_work: {
                entry: [
                  { type: "agent", agentId: "test-agent", prompt: "do the task" },
                  { type: "emit", event: "DONE" },
                ],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" },
            },
          },
        },
      },
      memory: opts?.memoryMounts,
    },
  };
}

function buildMockAdapter(): {
  bootstrap: ReturnType<typeof vi.fn>;
  store: typeof mockStoreFn;
  list: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
} {
  return {
    bootstrap: vi.fn<() => Promise<string>>().mockResolvedValue(""),
    store: mockStoreFn,
    list: vi.fn().mockResolvedValue([]),
    history: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

async function withTestRuntime(
  options: {
    memoryAdapter?: ReturnType<typeof buildMockAdapter>;
    memoryMounts?: Array<{
      name: string;
      source: string;
      mode: "ro" | "rw";
      scope: "workspace" | "job" | "agent";
      scopeTarget?: string;
    }>;
    memoryConfig?: MergedConfig["workspace"]["memory"];
  },
  fn: (runtime: import("../runtime.ts").WorkspaceRuntime) => Promise<void>,
): Promise<void> {
  const testDir = makeTempDir({ prefix: "atlas_standing_orders_test_" });
  const originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;

  const { WorkspaceRuntime } = await import("../runtime.ts");

  try {
    const config = createAgentConfig({ memoryMounts: options.memoryConfig });
    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
      memoryAdapter: options.memoryAdapter as import("@atlas/agent-sdk").MemoryAdapter | undefined,
      memoryMounts: options.memoryMounts,
      platformModels: createStubPlatformModels(),
    });

    await runtime.initialize();
    await fn(runtime);
    await runtime.shutdown();
  } finally {
    if (originalAtlasHome) {
      process.env.FRIDAY_HOME = originalAtlasHome;
    } else {
      delete process.env.FRIDAY_HOME;
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function fireSignal(runtime: import("../runtime.ts").WorkspaceRuntime) {
  return runtime.processSignal({
    id: "test-signal",
    type: "test-signal",
    data: {},
    timestamp: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("standing orders bootstrap injection", () => {
  const originalEnv = process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP;

  beforeEach(() => {
    capturedPrompts.length = 0;
    mockStoreFn.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = originalEnv;
    } else {
      delete process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP;
    }
  });

  it("loads global-level standing orders and prepends to prompt when flag=1", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("GLOBAL ORDER: never delete files"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toMatch(/^GLOBAL ORDER: never delete files\n\n/);
    expect(capturedPrompts[0]).toContain("do the task");
  });

  it("loads workspace-level standing orders after global level", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("GLOBAL ORDER"));
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WORKSPACE ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    const globalIdx = prompt.indexOf("GLOBAL ORDER");
    const wsIdx = prompt.indexOf("WORKSPACE ORDER");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(wsIdx).toBeGreaterThan(globalIdx);
  });

  it("loads mounted standing orders after workspace level", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("GLOBAL ORDER"));
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WORKSPACE ORDER"));
      }
      if (wsId === "other-ws" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("MOUNTED ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime(
      {
        memoryAdapter: adapter,
        memoryMounts: [
          {
            name: "ext-orders",
            source: "other-ws/narrative/standing-orders",
            mode: "ro",
            scope: "workspace",
          },
        ],
      },
      async (runtime) => {
        await fireSignal(runtime);
      },
    );

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    const globalIdx = prompt.indexOf("GLOBAL ORDER");
    const wsIdx = prompt.indexOf("WORKSPACE ORDER");
    const mountedIdx = prompt.indexOf("MOUNTED ORDER");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(wsIdx).toBeGreaterThan(globalIdx);
    expect(mountedIdx).toBeGreaterThan(wsIdx);
  });

  it("all three levels concatenate separated by double newlines", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("GLOBAL"));
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WORKSPACE"));
      }
      if (wsId === "other-ws" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("MOUNTED"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime(
      {
        memoryAdapter: adapter,
        memoryMounts: [
          {
            name: "ext-orders",
            source: "other-ws/narrative/standing-orders",
            mode: "ro",
            scope: "workspace",
          },
        ],
      },
      async (runtime) => {
        await fireSignal(runtime);
      },
    );

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toMatch(/^GLOBAL\n\nWORKSPACE\n\nMOUNTED\n\n/);
  });

  it("silently skips missing memory at any level — other levels still included", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.reject(new Error("directory not found"));
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WORKSPACE ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("WORKSPACE ORDER");
    expect(prompt).not.toContain("directory not found");
  });

  it("skips empty render results without spurious newlines", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock(""));
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WS ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toMatch(/^WS ORDER\n\n/);
    expect(prompt).not.toMatch(/^\n/);
  });

  it("does not call adapter when FRIDAY_STANDING_ORDERS_BOOTSTRAP is unset", async () => {
    delete process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP;
    mockStoreFn.mockResolvedValue(makeNarrativeMock("SHOULD NOT APPEAR"));

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(mockStoreFn).not.toHaveBeenCalled();
    expect(capturedPrompts[0]).not.toContain("SHOULD NOT APPEAR");
  });

  it("does not call adapter when FRIDAY_STANDING_ORDERS_BOOTSTRAP is '0'", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "0";
    mockStoreFn.mockResolvedValue(makeNarrativeMock("SHOULD NOT APPEAR"));

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(mockStoreFn).not.toHaveBeenCalled();
  });

  it("standing orders appear BEFORE the existing memory bootstrap in the final prompt", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";
    process.env.FRIDAY_MEMORY_BOOTSTRAP = "1";

    mockStoreFn.mockImplementation((_wsId: string, name: string): Promise<NarrativeStore> => {
      if (name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("STANDING ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;
    adapter.bootstrap = vi.fn<() => Promise<string>>().mockResolvedValue("MEMORY BOOTSTRAP");

    const originalMemEnv = process.env.FRIDAY_MEMORY_BOOTSTRAP;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    if (originalMemEnv !== undefined) {
      process.env.FRIDAY_MEMORY_BOOTSTRAP = originalMemEnv;
    } else {
      delete process.env.FRIDAY_MEMORY_BOOTSTRAP;
    }

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    const standingIdx = prompt.indexOf("STANDING ORDER");
    const bootstrapIdx = prompt.indexOf("MEMORY BOOTSTRAP");
    expect(standingIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(standingIdx);
  });

  it("error at one level does not prevent other levels from loading", async () => {
    process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";

    let callCount = 0;
    const failingMock = makeNarrativeMock("");
    failingMock.render = () => Promise.reject(new Error("render failed at global"));

    mockStoreFn.mockImplementation((wsId: string, name: string): Promise<NarrativeStore> => {
      callCount++;
      if (wsId === "_global" && name === "standing-orders") {
        return Promise.resolve(failingMock);
      }
      if (wsId === "test-workspace-id" && name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("WS ORDER SURVIVED"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("WS ORDER SURVIVED");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("hot-reads flag per-invocation — toggling env var mid-process takes effect on next signal", async () => {
    delete process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP;
    mockStoreFn.mockImplementation((_wsId: string, name: string): Promise<NarrativeStore> => {
      if (name === "standing-orders") {
        return Promise.resolve(makeNarrativeMock("STANDING ORDER"));
      }
      return Promise.reject(new Error("not found"));
    });

    const adapter = buildMockAdapter();
    adapter.store = mockStoreFn;

    await withTestRuntime({ memoryAdapter: adapter }, async (runtime) => {
      await fireSignal(runtime);
      expect(mockStoreFn).not.toHaveBeenCalled();

      process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP = "1";

      await fireSignal(runtime);
      expect(mockStoreFn).toHaveBeenCalled();
      expect(capturedPrompts[1]).toContain("STANDING ORDER");
    });
  });
});
