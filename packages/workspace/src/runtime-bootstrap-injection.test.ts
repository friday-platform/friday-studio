/**
 * Unit tests for memory bootstrap injection in WorkspaceRuntime.
 *
 * Verifies that when ATLAS_MEMORY_BOOTSTRAP=1 and a memoryAdapter is provided,
 * the bootstrap string is prepended to the prompt passed to the agent executor.
 *
 * Source: runtime.ts — bootstrap injection block in executeAgent()
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock AgentOrchestrator — captures the prompt arg passed to executeAgent
// ---------------------------------------------------------------------------

const capturedPrompts = vi.hoisted(() => [] as string[]);
const mockBootstrapFn = vi.hoisted(() => vi.fn<() => Promise<string>>());

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

/** FSM: idle → step_work (agent action + emit DONE) → complete */
function createAgentConfig(): MergedConfig {
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
    },
  };
}

async function withTestRuntime(
  options: { memoryAdapter?: { bootstrap: typeof mockBootstrapFn } },
  fn: (runtime: import("./runtime.ts").WorkspaceRuntime) => Promise<void>,
): Promise<void> {
  const testDir = makeTempDir({ prefix: "atlas_bootstrap_test_" });
  const originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;

  const { WorkspaceRuntime } = await import("./runtime.ts");

  try {
    const config = createAgentConfig();
    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
      memoryAdapter: options.memoryAdapter as import("@atlas/agent-sdk").MemoryAdapter | undefined,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory bootstrap injection", () => {
  const originalEnv = process.env.ATLAS_MEMORY_BOOTSTRAP;

  beforeEach(() => {
    capturedPrompts.length = 0;
    mockBootstrapFn.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ATLAS_MEMORY_BOOTSTRAP = originalEnv;
    } else {
      delete process.env.ATLAS_MEMORY_BOOTSTRAP;
    }
  });

  it("prepends bootstrap string to prompt when flag=1 and adapter is provided", async () => {
    process.env.ATLAS_MEMORY_BOOTSTRAP = "1";
    mockBootstrapFn.mockResolvedValue("## MEMORY CONTEXT\nsome important memory");

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
    });

    expect(mockBootstrapFn).toHaveBeenCalledOnce();
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toMatch(/^## MEMORY CONTEXT\nsome important memory\n\n/);
    expect(capturedPrompts[0]).toContain("do the task");
  });

  it("does not call bootstrap when ATLAS_MEMORY_BOOTSTRAP is unset", async () => {
    delete process.env.ATLAS_MEMORY_BOOTSTRAP;
    mockBootstrapFn.mockResolvedValue("## MEMORY");

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
    });

    expect(mockBootstrapFn).not.toHaveBeenCalled();
    expect(capturedPrompts[0]).not.toContain("## MEMORY");
  });

  it("does not call bootstrap when ATLAS_MEMORY_BOOTSTRAP is '0'", async () => {
    process.env.ATLAS_MEMORY_BOOTSTRAP = "0";
    mockBootstrapFn.mockResolvedValue("## MEMORY");

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
    });

    expect(mockBootstrapFn).not.toHaveBeenCalled();
  });

  it("does not attempt bootstrap when memoryAdapter is undefined", async () => {
    process.env.ATLAS_MEMORY_BOOTSTRAP = "1";

    await withTestRuntime({ memoryAdapter: undefined }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
    });

    // bootstrap was never defined — just verify agent ran with the raw prompt
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("do the task");
    expect(capturedPrompts[0]).not.toMatch(/^##/);
  });

  it("continues with original prompt when bootstrap throws", async () => {
    process.env.ATLAS_MEMORY_BOOTSTRAP = "1";
    mockBootstrapFn.mockRejectedValue(new Error("store unavailable"));

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      const session = await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
      // Session should still complete (bootstrap failure is non-fatal)
      expect(session.status).toBe("completed");
    });

    expect(mockBootstrapFn).toHaveBeenCalledOnce();
    // Prompt passed without bootstrap prefix
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("do the task");
    expect(capturedPrompts[0]).not.toContain("store unavailable");
  });

  it("passes prompt unchanged when bootstrap returns empty string", async () => {
    process.env.ATLAS_MEMORY_BOOTSTRAP = "1";
    mockBootstrapFn.mockResolvedValue("");

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
    });

    expect(mockBootstrapFn).toHaveBeenCalledOnce();
    expect(capturedPrompts).toHaveLength(1);
    // No spurious leading newlines
    expect(capturedPrompts[0]).not.toMatch(/^\n/);
    expect(capturedPrompts[0]).toContain("do the task");
  });

  it("hot-reads flag per-invocation — toggling env var mid-process takes effect", async () => {
    delete process.env.ATLAS_MEMORY_BOOTSTRAP;
    mockBootstrapFn.mockResolvedValue("## MEMORY");

    await withTestRuntime({ memoryAdapter: { bootstrap: mockBootstrapFn } }, async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
      expect(mockBootstrapFn).not.toHaveBeenCalled();

      process.env.ATLAS_MEMORY_BOOTSTRAP = "1";

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });
      expect(mockBootstrapFn).toHaveBeenCalledOnce();
      expect(capturedPrompts[1]).toMatch(/^## MEMORY\n\n/);
    });
  });
});
