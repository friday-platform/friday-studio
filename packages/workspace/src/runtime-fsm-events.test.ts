/**
 * Integration tests for FSM event emission in WorkspaceRuntime.
 * Verifies that FSM state transitions and action executions emit properly
 * structured UI chunks via the callback mechanism.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { expect, it } from "vitest";
import { WorkspaceRuntime } from "./runtime.ts";

const stubPlatformModels = createStubPlatformModels();

function createTestConfig(): MergedConfig {
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
              idle: { on: { "test-signal": { target: "processing" } } },
              processing: {
                entry: [{ type: "emit", event: "DONE" }],
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

it("WorkspaceRuntime emits FSM transition and action events via chunk callback", async () => {
  const testDir = makeTempDir({ prefix: "atlas_fsm_events_test_" });
  const originalAtlasHome = process.env.ATLAS_HOME;
  process.env.ATLAS_HOME = testDir;

  try {
    const config = createTestConfig();
    const collectedFsmChunks: AtlasUIMessageChunk[] = [];

    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
      platformModels: stubPlatformModels,
    });

    await runtime.initialize();

    await runtime.processSignal(
      { id: "test-signal", type: "test-signal", data: {}, timestamp: new Date() },
      (chunk) => {
        if (
          chunk.type === "data-fsm-state-transition" ||
          chunk.type === "data-fsm-action-execution"
        ) {
          collectedFsmChunks.push(chunk);
        }
      },
    );

    // Verify transition events: idle -> processing -> complete
    const transitionEvents = collectedFsmChunks.filter(
      (e): e is Extract<AtlasUIMessageChunk, { type: "data-fsm-state-transition" }> =>
        e.type === "data-fsm-state-transition",
    );
    expect(transitionEvents).toHaveLength(2);

    // First transition: idle -> processing (triggered by test-signal)
    expect(transitionEvents[0]).toMatchObject({
      data: {
        fromState: "idle",
        toState: "processing",
        jobName: "test-fsm",
        triggeringSignal: "test-signal",
      },
    });

    // Second transition: processing -> complete (triggered by DONE emit)
    expect(transitionEvents[1]).toMatchObject({
      data: { fromState: "processing", toState: "complete" },
    });

    // Verify action events: emit action in processing state
    const actionEvents = collectedFsmChunks.filter(
      (e): e is Extract<AtlasUIMessageChunk, { type: "data-fsm-action-execution" }> =>
        e.type === "data-fsm-action-execution",
    );
    expect(actionEvents.length).toBeGreaterThanOrEqual(2);

    // Verify emit action started and completed events exist with correct data
    expect(actionEvents).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "emit",
          status: "started",
          state: "processing",
          jobName: "test-fsm",
        }),
      }),
    );
    expect(actionEvents).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "emit", status: "completed" }),
      }),
    );

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
