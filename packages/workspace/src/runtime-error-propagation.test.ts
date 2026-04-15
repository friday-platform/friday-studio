/**
 * Tests that session errors propagate correctly through processSignal → IWorkspaceSession.
 *
 * Verifies:
 * - Failed FSM execution sets session.status = "failed" and session.error (string)
 * - Successful FSM execution sets session.status = "completed" and no error
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it } from "vitest";
import { WorkspaceRuntime } from "./runtime.ts";

const stubPlatformModels = createStubPlatformModels();

/** FSM with a code action that references a non-existent function → throws at execution */
function createFailingConfig(): MergedConfig {
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
              idle: { on: { "test-signal": { target: "processing" } } },
              processing: {
                entry: [{ type: "code", function: "nonexistent_function" }],
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

/** FSM that completes successfully (emit action only) */
function createSuccessConfig(): MergedConfig {
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

async function withTestRuntime<T>(
  config: MergedConfig,
  fn: (runtime: WorkspaceRuntime) => Promise<T>,
): Promise<T> {
  const testDir = makeTempDir({ prefix: "atlas_error_prop_test_" });
  const originalAtlasHome = process.env.ATLAS_HOME;
  process.env.ATLAS_HOME = testDir;

  try {
    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, config, {
      workspacePath: testDir,
      lazy: true,
      platformModels: stubPlatformModels,
    });
    await runtime.initialize();
    const result = await fn(runtime);
    await runtime.shutdown();
    return result;
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
}

describe("session error propagation", () => {
  it("failed FSM sets session.status to 'failed' with error string", async () => {
    const session = await withTestRuntime(createFailingConfig(), (runtime) =>
      runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      }),
    );

    expect(session.status).toBe("failed");
    expect(session.error).toBeTypeOf("string");
    expect(session.error).toContain("nonexistent_function");
  });

  it("successful FSM sets session.status to 'completed' with no error", async () => {
    const session = await withTestRuntime(createSuccessConfig(), (runtime) =>
      runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      }),
    );

    expect(session.status).toBe("completed");
    expect(session.error).toBeUndefined();
  });
});
