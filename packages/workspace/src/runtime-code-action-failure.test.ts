/**
 * Integration test: when a code action throws before an agent action in a
 * state's entry sequence, the agent block should be marked as failed (not
 * swept to "skipped" by session:complete).
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import type { SessionStreamEvent, SessionSummary } from "@atlas/core";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntime } from "./runtime.ts";

const stubPlatformModels = createStubPlatformModels();

// Stub the LLM-based summary generator
vi.mock("../../../apps/atlasd/src/session-summarizer.ts", () => ({
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSessionStream() {
  const events: SessionStreamEvent[] = [];
  let finalizedWith: SessionSummary | undefined;
  return {
    stream: {
      emit: (event: SessionStreamEvent) => {
        events.push(event);
      },
      emitEphemeral: () => {},
      finalize: (summary: SessionSummary) => {
        finalizedWith = summary;
        return Promise.resolve();
      },
      getBufferedEvents: () => [...events],
    },
    getEvents: () => events,
    getFinalizedSummary: () => finalizedWith,
  };
}

/**
 * FSM with: idle → step_work (code throws before agent) → complete.
 * The code action throws immediately, so the agent action never starts.
 */
function createCodeActionThrowsConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test-workspace", description: "Test workspace" },
      signals: {
        "test-signal": {
          provider: "http",
          description: "Test signal",
          config: { path: "/test-webhook" },
        },
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
                  { type: "code", function: "throw_error" },
                  { type: "agent", agentId: "test-agent" },
                  { type: "emit", event: "ADVANCE" },
                ],
                on: { ADVANCE: { target: "complete" } },
              },
              complete: { type: "final" },
            },
            functions: {
              throw_error: {
                type: "action",
                code: `export default function throw_error() { throw new Error("dependency not ready"); }`,
              },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("code action failure before agent action", () => {
  it("emits step:complete(failed) for the agent block instead of leaving it pending", async () => {
    const testDir = makeTempDir({ prefix: "atlas_code_throw_test_" });
    const originalAtlasHome = process.env.ATLAS_HOME;
    process.env.ATLAS_HOME = testDir;
    const mock = createMockSessionStream();

    try {
      const config = createCodeActionThrowsConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: () => mock.stream,
        platformModels: stubPlatformModels,
      });

      await runtime.initialize();

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      const events = mock.getEvents();

      // Session should be failed
      const completeEvent = events.find((e) => e.type === "session:complete");
      expect(completeEvent).toMatchObject({ type: "session:complete", status: "failed" });

      // The agent block should get step:start for the state that threw
      const stepStart = events.find(
        (e) => e.type === "step:start" && "stateId" in e && e.stateId === "step_work",
      );
      expect(stepStart).toBeDefined();
      expect(stepStart).toMatchObject({
        type: "step:start",
        agentName: "test-agent",
        stateId: "step_work",
        actionType: "agent",
      });

      // The agent block should get step:complete with failed status and error
      const stepComplete = events.find(
        (e) => e.type === "step:complete" && "status" in e && e.status === "failed",
      );
      expect(stepComplete).toBeDefined();
      expect(stepComplete).toMatchObject({ type: "step:complete", status: "failed" });
      expect((stepComplete as Record<string, unknown>).error).toContain("dependency not ready");

      await runtime.shutdown();
    } finally {
      if (originalAtlasHome) {
        process.env.ATLAS_HOME = originalAtlasHome;
      } else {
        delete process.env.ATLAS_HOME;
      }
      try {
        await rm(testDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });
});
