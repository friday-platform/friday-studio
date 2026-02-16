/**
 * Integration test: session:summary event is emitted AFTER session:complete
 * but BEFORE finalize, and the finalized summary includes aiSummary.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import type { SessionAISummary, SessionStreamEvent, SessionSummary } from "@atlas/core";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

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

vi.mock("./session-summarizer.ts", () => ({ generateSessionSummary: mockGenerateSessionSummary }));

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

/** Minimal SessionStream that buffers events and tracks finalize calls. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workspace-runtime session:summary wiring", () => {
  it("emits session:summary AFTER session:complete and BEFORE finalize, with aiSummary on finalized summary", async () => {
    const testDir = makeTempDir({ prefix: "atlas_session_summary_test_" });
    const originalAtlasHome = process.env.ATLAS_HOME;
    process.env.ATLAS_HOME = testDir;

    const mock = createMockSessionStream();

    try {
      const config = createTestConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
      });

      await runtime.initialize();

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      const events = mock.getEvents();
      const eventTypes = events.map((e) => e.type);

      // session:summary must appear in the event stream
      expect(eventTypes).toContain("session:summary");

      // Ordering: session:complete before session:summary
      const completeIdx = eventTypes.indexOf("session:complete");
      const summaryIdx = eventTypes.indexOf("session:summary");
      expect(completeIdx).toBeGreaterThan(-1);
      expect(summaryIdx).toBeGreaterThan(completeIdx);

      // Verify session:summary event content
      const summaryEvent = events.find((e) => e.type === "session:summary");
      expect(summaryEvent).toMatchObject({
        type: "session:summary",
        summary: mockSummary.summary,
        keyDetails: mockSummary.keyDetails,
      });

      // Verify finalize was called with aiSummary populated
      const finalized = mock.getFinalizedSummary();
      expect(finalized).toBeDefined();
      expect(finalized?.aiSummary).toEqual(mockSummary);

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

  it("finalizes without aiSummary when generation returns undefined", async () => {
    // Override mock for this test to return undefined
    mockGenerateSessionSummary.mockResolvedValueOnce(undefined);

    const testDir = makeTempDir({ prefix: "atlas_session_summary_test_" });
    const originalAtlasHome = process.env.ATLAS_HOME;
    process.env.ATLAS_HOME = testDir;

    const mock = createMockSessionStream();

    try {
      const config = createTestConfig();
      const runtime = new WorkspaceRuntime({ id: "test-ws" }, config, {
        workspacePath: testDir,
        lazy: true,
        createSessionStream: (_sessionId: string) => mock.stream,
      });

      await runtime.initialize();

      await runtime.processSignal({
        id: "test-signal",
        type: "test-signal",
        data: {},
        timestamp: new Date(),
      });

      const eventTypes = mock.getEvents().map((e) => e.type);

      // session:summary should NOT appear when generation returns undefined
      expect(eventTypes).not.toContain("session:summary");

      // Finalize should still be called, but without aiSummary
      const finalized = mock.getFinalizedSummary();
      expect(finalized).toBeDefined();
      expect(finalized?.aiSummary).toBeUndefined();

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
