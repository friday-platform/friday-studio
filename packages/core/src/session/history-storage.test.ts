import { rm } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { assert, assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { ReasoningResultStatus } from "../constants/supervisor-status.ts";
import {
  type AppendSessionEventInput,
  type CreateSessionMetadataInput,
  SessionHistoryStorage,
} from "./history-storage.ts";

let originalAtlasHome: string | undefined;
let testDir: string;

beforeEach(() => {
  testDir = makeTempDir({ prefix: "atlas_session_test_" });
  originalAtlasHome = process.env.ATLAS_HOME;
  process.env.ATLAS_HOME = testDir;
});

afterEach(async () => {
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
});

function createMetadataInput(sessionId: string): CreateSessionMetadataInput {
  return {
    sessionId,
    workspaceId: "workspace-123",
    status: ReasoningResultStatus.PARTIAL,
    signal: { id: "signal-abc", provider: { id: "timer", name: "Timer" } },
    signalPayload: { foo: "bar" },
    jobSpecificationId: "job-42",
    availableAgents: ["researcher"],
    streamId: "stream-1",
    artifactIds: [],
  };
}

describe("SessionHistoryStorage", () => {
  describe("Basic operations", () => {
    // Session file creation/retrieval works
    it("creates and retrieves session", async () => {
      const sessionId = crypto.randomUUID();
      const createResult = await SessionHistoryStorage.createSessionRecord(
        createMetadataInput(sessionId),
      );

      assert(createResult.ok);
      assertEquals(createResult.data.events.length, 0);

      const metadataResult = await SessionHistoryStorage.getSessionMetadata(sessionId);
      assert(metadataResult.ok);
      assert(metadataResult.data);
    });

    // Events append to session, retrieve via timeline
    it("appends and retrieves events", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const eventInput: AppendSessionEventInput = {
        sessionId,
        emittedBy: "session-supervisor",
        event: {
          type: "agent-start",
          context: { phaseId: "phase-1", agentId: "agent-1" },
          data: {
            agentId: "agent-1",
            executionId: "exec-1",
            input: { task: "demo" },
            promptSummary: "Analyze input",
          },
        },
      };

      const appendResult = await SessionHistoryStorage.appendSessionEvent(eventInput);
      assert(appendResult.ok);

      const timelineResult = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timelineResult.ok);
      assert(timelineResult.data);
      assertEquals(timelineResult.data.events.length, 1);
    });

    // Missing sessions return null, not error
    it("returns null for non-existent session", async () => {
      const result = await SessionHistoryStorage.getSessionMetadata(crypto.randomUUID());
      assert(result.ok);
      assertEquals(result.data, null);
    });
  });

  describe("Concurrency", () => {
    // Mixed appends + metadata updates don't corrupt or lose data
    it("handles concurrent session updates", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          SessionHistoryStorage.appendSessionEvent({
            sessionId,
            emittedBy: "test",
            event: { type: "supervisor-action", data: { action: `concurrent-${i}` } },
          }),
        );
        promises.push(
          SessionHistoryStorage.markSessionComplete(
            sessionId,
            ReasoningResultStatus.PARTIAL,
            new Date().toISOString(),
            { summary: `update-${i}` },
          ),
        );
      }

      const results = await Promise.all(promises);
      for (const result of results) {
        assert(result.ok, "All concurrent operations should succeed");
      }

      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok);
      assert(timeline.data);
      assertEquals(timeline.data.events.length, 5);
    });

    // Concurrent title updates don't corrupt data
    it("handles concurrent title updates without corruption", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const titles = ["First Title", "Second Title", "Third Title", "Fourth Title", "Fifth Title"];

      const promises = titles.map((title) =>
        SessionHistoryStorage.updateSessionTitle(sessionId, title),
      );

      const results = await Promise.all(promises);
      for (const result of results) {
        assert(result.ok, "All concurrent title updates should succeed");
      }

      const metadata = await SessionHistoryStorage.getSessionMetadata(sessionId);
      assert(metadata.ok);
      assert(metadata.data);
      // Title should be one of the values we wrote, not garbage
      assert(
        titles.includes(metadata.data.title ?? ""),
        `Title should be one of the written values, got: ${metadata.data.title}`,
      );
    });
  });

  describe("Idempotency", () => {
    // Re-creating existing session returns existing data without clobbering
    it("createSession preserves existing events and metadata", async () => {
      const sessionId = crypto.randomUUID();
      const result1 = await SessionHistoryStorage.createSessionRecord(
        createMetadataInput(sessionId),
      );
      assert(result1.ok);

      await SessionHistoryStorage.appendSessionEvent({
        sessionId,
        emittedBy: "test",
        event: { type: "supervisor-action", data: { action: "important" } },
      });

      const result2 = await SessionHistoryStorage.createSessionRecord(
        createMetadataInput(sessionId),
      );
      assert(result2.ok);

      const finalSession = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(finalSession.ok);
      assertEquals(finalSession.data?.events.length, 1);
      assertEquals(finalSession.data?.metadata.createdAt, result1.data.createdAt);
    });
  });

  describe("listSessions", () => {
    // Filters sessions to requested workspace only
    it("lists sessions by workspace", async () => {
      const session1 = crypto.randomUUID();
      const session2 = crypto.randomUUID();
      const session3 = crypto.randomUUID();

      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session1));
      await SessionHistoryStorage.createSessionRecord({
        ...createMetadataInput(session2),
        workspaceId: "workspace-456",
      });
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session3));

      const result = await SessionHistoryStorage.listSessions({ workspaceId: "workspace-123" });
      assert(result.ok);
      assertEquals(result.data.sessions.length, 2);
      assert(result.data.sessions.every((s) => s.workspaceId === "workspace-123"));
    });

    // Sorts by mtime descending (most recent first)
    it("returns most recently updated first", async () => {
      const session1 = crypto.randomUUID();
      const session2 = crypto.randomUUID();
      const session3 = crypto.randomUUID();

      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session3));
      await new Promise((resolve) => setTimeout(resolve, 50));

      await SessionHistoryStorage.appendSessionEvent({
        sessionId: session1,
        emittedBy: "test",
        event: { type: "supervisor-action", data: { action: "update" } },
      });

      const result = await SessionHistoryStorage.listSessions({ workspaceId: "workspace-123" });
      assert(result.ok);
      assertEquals(result.data.sessions.length, 3);
      assertEquals(result.data.sessions[0]?.sessionId, session1);
    });
  });
});
