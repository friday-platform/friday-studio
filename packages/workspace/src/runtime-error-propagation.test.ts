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

/** FSM with an agent action referencing a non-existent agent → throws at execution */
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
                entry: [{ type: "agent", agentId: "nonexistent-agent" }],
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
  const originalAtlasHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = testDir;

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

  it("cancelSession unblocks the await even when engine.signal ignores AbortSignal", async () => {
    // Repro: a workspace agent makes a blocking call (e.g. a fetch with no
    // signal piped through) so `engine.signal` never settles. Without the
    // `awaitWithAbort` race in processSignalForJob, `cancelSession` aborts
    // the per-session controller but the await stays pending, the
    // `activeAbortControllers` entry never clears, and the cascade-stream
    // in-flight slot stays pinned — so the next trigger of the same signal
    // hits skipped-duplicate forever. The fix: cancel must complete the
    // outer await within ~1 tick of `controller.abort()` regardless of
    // what the engine is doing inside.
    await withTestRuntime(createSuccessConfig(), async (runtime) => {
      // Hijack the FSM engine's signal method on the *next* engine the
      // runtime creates so it returns a never-settling promise but exposes
      // its onEvent / onStreamEvent callbacks to the test. Wrapping
      // createJobEngine is the smallest seam — every signal trigger goes
      // through it once. createJobEngine is private; cast via unknown.
      const captured: { onEvent?: (e: unknown) => void; onStreamEvent?: (c: unknown) => void } = {};
      const r = runtime as unknown as {
        createJobEngine: (
          ...args: unknown[]
        ) => Promise<{ engine: { signal: (...args: unknown[]) => unknown } }>;
      };
      const original = r.createJobEngine.bind(r);
      r.createJobEngine = async (...args: unknown[]) => {
        const result = await original(...args);
        result.engine.signal = (...args: unknown[]) => {
          const ctx = args[1] as
            | { onEvent?: (e: unknown) => void; onStreamEvent?: (c: unknown) => void }
            | undefined;
          captured.onEvent = ctx?.onEvent;
          captured.onStreamEvent = ctx?.onStreamEvent;
          return new Promise(() => {});
        };
        return result;
      };

      // Capture stream events emitted to the SSE-style outer callback so we
      // can assert later events from the orphan engine are dropped.
      const outerEvents: Array<{ type: string }> = [];
      const sessionPromise = runtime.triggerSignalWithSession(
        "test-signal",
        {},
        undefined,
        (chunk) => {
          outerEvents.push(chunk as { type: string });
        },
        undefined,
        undefined,
      );

      // Wait until the controller is registered, then cancel.
      const start = Date.now();
      let activeId: string | undefined;
      while (Date.now() - start < 5_000) {
        const ids = (runtime as unknown as { activeAbortControllers: Map<string, unknown> })
          .activeAbortControllers;
        const first = ids.keys().next();
        if (!first.done) {
          activeId = first.value;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(activeId).toBeTruthy();

      runtime.cancelSession(activeId as string);

      // The session must finalize promptly despite engine.signal being
      // wedged — well under the 30s test timeout.
      const session = await Promise.race([
        sessionPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("processSignal did not resolve after cancel")), 5_000),
        ),
      ]);

      expect(session.status).toBe("cancelled");
      // hasActiveSession must clear so subsequent triggers aren't blocked.
      expect(runtime.hasActiveSession(activeId as string)).toBe(false);

      // Orphan engine.signal is still alive — simulate a late callback as
      // the underlying work eventually progresses. The `finalized` gate
      // must drop these so they can't land in JetStream after
      // `session:complete` was emitted.
      const eventsBefore = outerEvents.length;
      captured.onEvent?.({
        type: "data-fsm-state-transition",
        data: {
          sessionId: activeId,
          workspaceId: "test-workspace-id",
          jobName: "test-job",
          fromState: "processing",
          toState: "complete",
          triggeringSignal: "test-signal",
          timestamp: new Date().toISOString(),
        },
      });
      captured.onStreamEvent?.({ type: "text-delta", id: "x", delta: "late" });
      expect(outerEvents.length).toBe(eventsBefore);
    });
  });

  it("externally-passed abortSignal cancels the session — closes the cascade-replace abort chain", async () => {
    // Regression: `CascadeConsumer`'s `replace` policy aborts the
    // AbortController it created, then passes that signal through
    // `triggerWorkspaceSignal` → `triggerSignalWithSession`. The
    // runtime composes it with its per-session controller at
    // `runtime.ts:998-1009` and checks `effectiveAbortSignal.aborted`
    // in the catch block at line 1191. This test covers the runtime
    // half of that chain — that the externally-passed abortSignal
    // really does steer status to `cancelled` instead of `failed`,
    // even when an action throws for an unrelated reason.
    //
    // Uses the failing-FSM config (agent-not-found) so the action
    // throws synchronously; with the abortSignal pre-aborted, the
    // catch clause should classify as cancelled.
    const session = await withTestRuntime(createFailingConfig(), (runtime) => {
      const controller = new AbortController();
      controller.abort("replaced by newer cascade");
      return runtime.triggerSignalWithSession(
        "test-signal",
        {},
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
    });

    expect(session.status).toBe("cancelled");
  });
});
