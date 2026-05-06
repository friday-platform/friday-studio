/**
 * Integration test for the C2 detached-aiSummary flow:
 *  - finalize() resolves before generateSessionSummary settles (synchronous
 *    fallback aiSummary lands on `job-complete` immediately)
 *  - session:summary event is emitted asynchronously once the LLM round-trip
 *    completes
 *  - completedSessionMetadata + persisted KV are updated out-of-band
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import type { SessionAISummary, SessionStreamEvent, SessionSummary } from "@atlas/core";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it, vi } from "vitest";

const fakePlatformModels = createStubPlatformModels();

// ---------------------------------------------------------------------------
// Mock generateSessionSummary — it calls an LLM, so we stub it
// ---------------------------------------------------------------------------

const { mockSummary, mockGenerateSessionSummary } = vi.hoisted(() => {
  const mockSummary: SessionAISummary = {
    summary: "Processed test signal successfully.",
    keyDetails: [{ label: "Signal", value: "test-signal" }],
  };
  return { mockSummary, mockGenerateSessionSummary: vi.fn().mockResolvedValue(mockSummary) };
});

vi.mock("../../../apps/atlasd/src/session-summarizer.ts", () => ({
  generateSessionSummary: mockGenerateSessionSummary,
}));

// ---------------------------------------------------------------------------
// Mock AgentOrchestrator — runtime gates session:summary on executed agent
// blocks. Provide a stub so the FSM's `agent` step records as "executed".
// ---------------------------------------------------------------------------

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
    executeAgent(): Promise<AgentResult> {
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

const { WorkspaceRuntime } = await import("./runtime.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
          description: "A test job for summary generation",
          triggers: [{ signal: "test-signal" }],
          fsm: {
            id: "test-fsm",
            initial: "idle",
            states: {
              idle: { on: { "test-signal": { target: "processing" } } },
              processing: {
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

/** Minimal SessionStream that buffers events and tracks finalize calls. */
function createMockSessionStream() {
  const events: SessionStreamEvent[] = [];
  let finalizedWith: SessionSummary | undefined;
  let updatedWith: SessionSummary | undefined;

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
      updateSummary: (summary: SessionSummary) => {
        updatedWith = summary;
        return Promise.resolve();
      },
      getBufferedEvents: () => [...events],
    },
    getEvents: () => events,
    getFinalizedSummary: () => finalizedWith,
    getUpdatedSummary: () => updatedWith,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workspace-runtime session:summary wiring (C2 detached path)", () => {
  it("emits a follow-up session:summary AFTER finalize once async generation resolves; persists via updateSummary", async () => {
    const testDir = makeTempDir({ prefix: "atlas_session_summary_test_" });
    const originalAtlasHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = testDir;

    const mock = createMockSessionStream();

    // Defer generateSessionSummary so we can observe finalize-before-LLM
    // ordering. Resolved manually below.
    let resolveSummary!: (s: SessionAISummary | undefined) => void;
    mockGenerateSessionSummary.mockImplementationOnce(
      () =>
        new Promise<SessionAISummary | undefined>((resolve) => {
          resolveSummary = resolve;
        }),
    );

    try {
      const config = createTestConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
        platformModels: fakePlatformModels,
      });

      await runtime.initialize();

      const processPromise = runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      // processSignal awaits finalize(); finalize resolves before
      // generateSessionSummary is allowed to settle. The await below
      // therefore returns with the synchronous fallback in place — the
      // LLM mock is still pending.
      await processPromise;

      // Critical-path assertion: finalize() ran with the *synchronous*
      // aiSummary (or undefined when there's nothing to summarize). It
      // did NOT block on the LLM round-trip.
      const finalized = mock.getFinalizedSummary();
      expect(finalized).toBeDefined();
      expect(finalized?.aiSummary).not.toEqual(mockSummary);

      // Now resolve the LLM mock and let microtasks flush so the .then
      // in the runtime can run.
      resolveSummary(mockSummary);
      // Small awaits give the detached promise chain time to settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // The follow-up session:summary event landed with the polished body.
      const summaryEvents = mock.getEvents().filter((e) => e.type === "session:summary");
      expect(summaryEvents.length).toBeGreaterThanOrEqual(1);
      const lastSummary = summaryEvents.at(-1);
      expect(lastSummary).toMatchObject({
        type: "session:summary",
        summary: mockSummary.summary,
        keyDetails: mockSummary.keyDetails,
      });

      // updateSummary was invoked with the LLM-generated aiSummary so the
      // persisted KV reflects the polished body.
      const updated = mock.getUpdatedSummary();
      expect(updated).toBeDefined();
      expect(updated?.aiSummary).toEqual(mockSummary);

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

  it("finalizes and skips updateSummary when async generation returns undefined", async () => {
    mockGenerateSessionSummary.mockResolvedValueOnce(undefined);

    const testDir = makeTempDir({ prefix: "atlas_session_summary_test_" });
    const originalAtlasHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = testDir;

    const mock = createMockSessionStream();

    try {
      const config = createTestConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
        platformModels: fakePlatformModels,
      });

      await runtime.initialize();

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      // Allow the detached promise to settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // The FSM in this test has no `outputTo` doc and no terminal-action
      // `summary:`, so the synchronous fallback is empty and gets
      // suppressed; the async path resolves to undefined → no follow-up
      // emission either.
      const eventTypes = mock.getEvents().map((e) => e.type);
      expect(eventTypes).not.toContain("session:summary");

      // Finalize ran with no aiSummary, and updateSummary was never
      // called (async path bailed on undefined).
      const finalized = mock.getFinalizedSummary();
      expect(finalized).toBeDefined();
      expect(finalized?.aiSummary).toBeUndefined();
      expect(mock.getUpdatedSummary()).toBeUndefined();

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

  it("survives async generation rejection: warns, no crash, finalize still ran", async () => {
    mockGenerateSessionSummary.mockRejectedValueOnce(new Error("boom"));

    const testDir = makeTempDir({ prefix: "atlas_session_summary_test_" });
    const originalAtlasHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = testDir;

    const mock = createMockSessionStream();

    try {
      const config = createTestConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
        platformModels: fakePlatformModels,
      });

      await runtime.initialize();

      await expect(
        runtime.processSignal({
          id: "test-signal",
          type: "test-signal",
          data: {},
          timestamp: new Date(),
        }),
      ).resolves.toBeDefined();

      // Allow the detached rejection to land in the .catch handler.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // No crash; finalize still ran; updateSummary never called.
      expect(mock.getFinalizedSummary()).toBeDefined();
      expect(mock.getUpdatedSummary()).toBeUndefined();

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
