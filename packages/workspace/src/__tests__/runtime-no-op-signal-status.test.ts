/**
 * Regression guard for the silent-no-op signal bug (#322).
 *
 * Contract: when the engine drains the signal queue without committing
 * any transition (e.g. an FSM whose current state has no `on:` handler
 * for the incoming signal), the session must surface as `SKIPPED`, not
 * `COMPLETED`. The downstream chain converts `SKIPPED` to a `job-error`
 * SSE event, which the chat-tool wrapper returns as `success: false`.
 * Without that, the chat agent reports "Done — successfully" for a
 * session that did literally nothing.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import { WorkspaceSessionStatus } from "@atlas/core";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceRuntime } from "../runtime.ts";

const stubPlatformModels = createStubPlatformModels();

function configWithFinalInitialFSM(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "no-op-signal-test", description: "Silent no-op repro" },
      signals: {
        reindex: {
          provider: "http",
          description: "Trigger reindex",
          config: { path: "/webhooks/reindex" },
        },
      },
      jobs: {
        "reindex-knowledge-base": {
          description: "Final-state-only FSM — accepts the signal but has nowhere to go.",
          triggers: [{ signal: "reindex" }],
          fsm: { initial: "done", states: { done: { type: "final" } } },
        },
      },
    },
  };
}

let testDir: string;
let originalAtlasHome: string | undefined;
let runtime: WorkspaceRuntime | undefined;

beforeEach(() => {
  testDir = makeTempDir({ prefix: "atlas_no_op_signal_test_" });
  originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;
});

afterEach(async () => {
  if (runtime) {
    await runtime.shutdown().catch(() => {});
    runtime = undefined;
  }
  if (originalAtlasHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalAtlasHome;
  await rm(testDir, { recursive: true, force: true });
});

it("flags a signal that took no transition as SKIPPED, not COMPLETED (refs #322)", async () => {
  runtime = new WorkspaceRuntime({ id: "test-no-op" }, configWithFinalInitialFSM(), {
    workspacePath: testDir,
    lazy: true,
    platformModels: stubPlatformModels,
  });
  await runtime.initialize();

  const session = await runtime.triggerSignalWithSession("reindex", {});

  expect(session.status).not.toBe(WorkspaceSessionStatus.COMPLETED);
  expect(session.status).toBe(WorkspaceSessionStatus.SKIPPED);
});
