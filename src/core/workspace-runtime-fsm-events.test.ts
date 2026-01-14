/**
 * Integration tests for FSM event emission in WorkspaceRuntime.
 * Verifies that FSM state transitions and action executions emit properly
 * structured UI chunks via the callback mechanism.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { makeTempDir } from "@atlas/utils/temp.server";
import { assert } from "@std/assert";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

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

Deno.test("WorkspaceRuntime emits FSM transition and action events via chunk callback", async () => {
  const testDir = makeTempDir({ prefix: "atlas_fsm_events_test_" });
  const originalAtlasHome = process.env.ATLAS_HOME;
  process.env.ATLAS_HOME = testDir;

  try {
    const config = createTestConfig();
    const collectedFsmChunks: AtlasUIMessageChunk[] = [];

    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
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
    assert(transitionEvents.length === 2, `Expected 2 transitions, got ${transitionEvents.length}`);

    // First transition: idle -> processing (triggered by test-signal)
    const firstTransition = transitionEvents[0]!;
    assert(firstTransition.data.fromState === "idle", "First transition should be from idle");
    assert(
      firstTransition.data.toState === "processing",
      "First transition should be to processing",
    );
    assert(firstTransition.data.jobName === "test-fsm", "Transition should have FSM id as jobName");
    assert(
      firstTransition.data.triggeringSignal === "test-signal",
      "Should capture triggering signal",
    );

    // Second transition: processing -> complete (triggered by DONE emit)
    const secondTransition = transitionEvents[1]!;
    assert(
      secondTransition.data.fromState === "processing",
      "Second transition should be from processing",
    );
    assert(secondTransition.data.toState === "complete", "Second transition should be to complete");

    // Verify action events: emit action in processing state
    const actionEvents = collectedFsmChunks.filter(
      (e): e is Extract<AtlasUIMessageChunk, { type: "data-fsm-action-execution" }> =>
        e.type === "data-fsm-action-execution",
    );
    assert(
      actionEvents.length >= 2,
      `Expected at least 2 action events (start+complete), got ${actionEvents.length}`,
    );

    // Find the emit action events
    const emitStarted = actionEvents.find(
      (e) => e.data.actionType === "emit" && e.data.status === "started",
    );
    const emitCompleted = actionEvents.find(
      (e) => e.data.actionType === "emit" && e.data.status === "completed",
    );
    assert(emitStarted, "Should have emit action started event");
    assert(emitCompleted, "Should have emit action completed event");
    assert(emitStarted.data.state === "processing", "Emit action should be in processing state");
    assert(emitStarted.data.jobName === "test-fsm", "Action should have FSM id as jobName");

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
