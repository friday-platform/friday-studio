/**
 * Unit test for the agent-prompt composition call site in
 * `WorkspaceRuntime.executeAgent`.
 *
 * `composeAgentPrompt` itself is unit-tested in
 * `apps/atlasd/src/agent-helpers.test.ts`. That test pins the helper, but it
 * does NOT pin the call site — a future refactor that re-inlines the
 * composition logic in `runtime.ts` (the original shape of the bug fixed in
 * PR #215) would not be caught by helper-only tests.
 *
 * This test mocks `AgentOrchestrator.executeAgent` to capture the prompt arg,
 * configures a workspace whose agent has BOTH a config-level prompt and a
 * per-step FSM action prompt, and asserts both reach the agent.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { atlasAgent } from "@atlas/config/testing";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock AgentOrchestrator — captures the prompt arg passed to executeAgent
// ---------------------------------------------------------------------------

const capturedPrompts = vi.hoisted(() => [] as string[]);
const releasedSessions = vi.hoisted(() => [] as string[]);

vi.mock("@atlas/core", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/core")>();

  const successResult: AgentResult = {
    agentId: "pixel-asset-generator",
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
    releaseSession(sessionId: string) {
      releasedSessions.push(sessionId);
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
  }

  return { ...actual, AgentOrchestrator: MockAgentOrchestrator };
});

const { WorkspaceRuntime } = await import("./runtime.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_PROMPT = "Background must always be solid neon green (#00FF00).";
const ACTION_PROMPT = "Generate a sprite of a {{inputs.subject}}.";

/**
 * Workspace with an atlas-typed agent that has its own config-level prompt,
 * plus an FSM action that sets a per-step prompt with `{{inputs.x}}`.
 */
function createConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "select-noodle-test", description: "Both-layer prompt regression" },
      agents: {
        "pixel-asset-generator": atlasAgent({
          agent: "image-generation",
          description: "pixel asset generator",
          prompt: CONFIG_PROMPT,
        }),
      },
      signals: {
        "test-signal": { provider: "http", description: "Test signal", config: { path: "/test" } },
      },
      jobs: {
        "test-job": {
          triggers: [{ signal: "test-signal" }],
          fsm: {
            id: "test-fsm",
            initial: "idle",
            context: { inputs: { subject: "robot chef" } },
            states: {
              idle: { on: { "test-signal": { target: "generate" } } },
              generate: {
                entry: [
                  { type: "agent", agentId: "pixel-asset-generator", prompt: ACTION_PROMPT },
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
  fn: (runtime: import("./runtime.ts").WorkspaceRuntime) => Promise<void>,
): Promise<void> {
  const testDir = makeTempDir({ prefix: "atlas_agent_prompt_test_" });
  const originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;

  try {
    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, createConfig(), {
      workspacePath: testDir,
      lazy: true,
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
// Test
// ---------------------------------------------------------------------------

describe("runtime.executeAgent — agent prompt composition (call site)", () => {
  it("passes BOTH the agent-config prompt and the (interpolated) action prompt to executeAgent", async () => {
    capturedPrompts.length = 0;
    releasedSessions.length = 0;

    await withTestRuntime(async (runtime) => {
      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: { subject: "robot chef" },
        timestamp: new Date(),
      });
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0] ?? "";

    // Config-layer guidance reaches the agent — this is the regression the bug
    // was about: it used to be silently dropped when the action also set a prompt.
    expect(prompt).toContain(CONFIG_PROMPT);

    // Action-layer task also reaches the agent, with `{{inputs.x}}` interpolated.
    expect(prompt).toContain("Generate a sprite of a robot chef.");
    expect(prompt).not.toContain("{{inputs.subject}}");

    // Order: config (agent-wide) before action (per-step), matching the
    // contract pinned in apps/atlasd/src/agent-helpers.test.ts.
    expect(prompt.indexOf(CONFIG_PROMPT)).toBeLessThan(
      prompt.indexOf("Generate a sprite of a robot chef."),
    );
  });

  it("releases the orchestrator session when the workspace session completes", async () => {
    releasedSessions.length = 0;

    let sessionId: string | undefined;
    await withTestRuntime(async (runtime) => {
      const session = await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: { subject: "robot chef" },
        timestamp: new Date(),
      });
      sessionId = session.id;
    });

    expect(releasedSessions).toEqual([sessionId]);
  });
});
