/**
 * Smoke test for FSMValidationAttemptEvent → step:validation forwarding.
 *
 * Verifies that the workspace runtime's onEvent handler routes
 * `data-fsm-validation-attempt` events through the same `sessionStream`
 * pipeline that already carries `step:start` / `step:complete` /
 * `step:skipped`. Drives a real FSM with an `llm` action while stubbing the
 * LLM provider and validator so the test stays deterministic and offline.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import type { SessionStreamEvent, SessionSummary } from "@atlas/core";
import type { FSMLLMOutput, LLMActionTrace } from "@atlas/fsm-engine";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it, vi } from "vitest";

const stubPlatformModels = createStubPlatformModels();

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
// Replace `AtlasLLMProviderAdapter` so the FSM's `llm` action returns a
// deterministic AgentResult without touching network or the real LanguageModel.
// Replace `createFSMOutputValidator` so we control which verdict the engine
// sees — that's what triggers the `running` / `passed` / `failed` lifecycle
// emissions on the FSMEvent stream.

vi.mock("@atlas/fsm-engine", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/fsm-engine")>();

  class StubLLMProviderAdapter {
    call(params: { agentId: string; prompt: string }): Promise<AgentResult<string, FSMLLMOutput>> {
      return Promise.resolve({
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: true,
        data: { response: "stub llm output" },
        toolCalls: [],
        toolResults: [],
        durationMs: 0,
      });
    }
  }

  return { ...actual, AtlasLLMProviderAdapter: StubLLMProviderAdapter };
});

vi.mock("@atlas/hallucination", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/hallucination")>();

  function createFSMOutputValidator() {
    return (_trace: LLMActionTrace, _abortSignal?: AbortSignal) =>
      Promise.resolve({
        verdict: {
          status: "pass" as const,
          confidence: 0.95,
          threshold: 0.45,
          issues: [],
          retryGuidance: "",
        },
      });
  }

  return { ...actual, createFSMOutputValidator };
});

const { WorkspaceRuntime } = await import("./runtime.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createLLMActionConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "validation-test-workspace", description: "Validation test" },
      signals: {
        "test-signal": {
          provider: "http",
          description: "Trigger validation",
          config: { path: "/test-webhook" },
        },
      },
      jobs: {
        "validation-job": {
          triggers: [{ signal: "test-signal" }],
          fsm: {
            id: "validation-fsm",
            initial: "idle",
            states: {
              idle: { on: { "test-signal": { target: "running-llm" } } },
              "running-llm": {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-haiku-4-5",
                    prompt: "anything",
                    outputTo: "result",
                  },
                ],
                always: { target: "complete" },
              },
              complete: { type: "final" },
            },
          },
        },
      },
    },
  };
}

function createMockSessionStream() {
  const events: SessionStreamEvent[] = [];
  return {
    stream: {
      emit: (event: SessionStreamEvent) => {
        events.push(event);
      },
      emitEphemeral: () => {},
      finalize: (_summary: SessionSummary) => Promise.resolve(),
      getBufferedEvents: () => [...events],
    },
    getEvents: () => events,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("workspace-runtime FSMValidationAttemptEvent forwarding", () => {
  it("forwards running and terminal validation events to sessionStream as step:validation", async () => {
    const testDir = makeTempDir({ prefix: "atlas_validation_events_test_" });
    const originalAtlasHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = testDir;

    const mock = createMockSessionStream();

    try {
      const runtime = new WorkspaceRuntime({ id: "validation-test-ws" }, createLLMActionConfig(), {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
        platformModels: stubPlatformModels,
      });

      await runtime.initialize();

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      const validationEvents = mock.getEvents().filter((e) => e.type === "step:validation");

      // AC: "at least one running and one terminal validation event are present
      // in the workspace runtime's emitted stream"
      expect(validationEvents.length).toBeGreaterThanOrEqual(2);

      const running = validationEvents.find((e) => e.status === "running");
      const passed = validationEvents.find((e) => e.status === "passed");

      expect(running).toBeDefined();
      expect(passed).toBeDefined();

      // Both events correlate to the parent action via actionId.
      expect(running?.actionId).toBeTruthy();
      expect(passed?.actionId).toEqual(running?.actionId);

      // Terminal `passed` carries the verdict, `running` does not.
      expect(passed?.verdict?.status).toEqual("pass");
      expect(running?.verdict).toBeUndefined();

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
        // Ignore cleanup errors
      }
    }
  });
});
