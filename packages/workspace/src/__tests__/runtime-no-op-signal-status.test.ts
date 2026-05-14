/**
 * Failing-test guard for the silent-no-op signal bug.
 *
 * Repro: a workspace job declares an FSM whose initial state is also a
 * `type: final` state with no `on:` transitions. When the matching
 * signal is fired, `FSMEngine.processSingleSignalInner` (fsm-engine.ts
 * ~line 782) finds no `state.on[sig.type]`, logs DEBUG "No transition
 * defined for signal", and returns void. The runtime caller
 * (`runtime.ts` ~line 2083) sees no error from `engine.signal(...)`,
 * sets `session.status = COMPLETED`, and emits "Signal processed
 * successfully". Downstream chat-tool wrapper (`packages/system/agents/
 * workspace-chat/tools/job-tools.ts:404`) then returns
 * `{ success: true, status: "completed", artifactIds: [], summary: <empty
 * sentinel> }` — and the chat agent reports "Done — successfully" for a
 * session that did literally nothing.
 *
 * Discovered during a chat-driven QA round when a no-op fixture FSM
 * caused the chat agent to report a clean success on a job that did
 * literally nothing. Root-cause investigation pinpointed the engine's
 * silent return as the contract gap.
 *
 * Desired contract (this test asserts the fix): when the engine takes
 * zero transitions on a signal, the session must surface as `SKIPPED`,
 * not `COMPLETED`. This is the signal the chat-tool wrapper needs to
 * stop returning `success: true` for empty no-op runs.
 *
 * Currently failing — keeps failing until the runtime / engine plumbing
 * is taught to flag "transition not taken" as a non-completion.
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

it("[FAILING] flags a signal that took no transition as SKIPPED, not COMPLETED", async () => {
  runtime = new WorkspaceRuntime({ id: "test-no-op" }, configWithFinalInitialFSM(), {
    workspacePath: testDir,
    lazy: true,
    platformModels: stubPlatformModels,
  });
  await runtime.initialize();

  const session = await runtime.triggerSignalWithSession("reindex", {});

  // Contract: a session that performed zero work and took zero
  // transitions must NOT report `completed`. The chat-tool wrapper
  // turns `completed` into `success: true` and the conversational
  // agent then hallucinates a successful run. The right signal here
  // is `skipped` — same status the runtime already uses for "user
  // configuration issue" cases.
  //
  // Currently fails: runtime.ts:2083 sets COMPLETED whenever
  // engine.signal() didn't throw, regardless of whether any
  // transition fired.
  expect(session.status).not.toBe(WorkspaceSessionStatus.COMPLETED);
  expect(session.status).toBe(WorkspaceSessionStatus.SKIPPED);
});
