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
          type: "fsm-action",
          context: { agentId: "agent-1", executionId: "exec-1" },
          data: {
            jobName: "test-job",
            state: "processing",
            actionType: "agent",
            actionId: "agent-1",
            status: "started",
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

    // Custom emittedAt preserves original timestamps
    it("preserves custom emittedAt timestamp", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const customTimestamp = "2024-01-15T10:30:00.000Z";
      const eventInput: AppendSessionEventInput = {
        sessionId,
        emittedBy: "workspace-runtime",
        emittedAt: customTimestamp,
        event: {
          type: "fsm-action",
          context: { metadata: { fsmEventType: "action" } },
          data: {
            jobName: "test-job",
            state: "processing",
            actionType: "emit",
            status: "completed",
          },
        },
      };

      const appendResult = await SessionHistoryStorage.appendSessionEvent(eventInput);
      assert(appendResult.ok);
      assertEquals(appendResult.data.emittedAt, customTimestamp);

      const timelineResult = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timelineResult.ok);
      assert(timelineResult.data);
      assertEquals(timelineResult.data.events[0]?.emittedAt, customTimestamp);
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
            event: {
              type: "fsm-action",
              data: {
                jobName: "test-job",
                state: "processing",
                actionType: "emit",
                status: "completed",
              },
            },
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
        event: {
          type: "fsm-action",
          data: {
            jobName: "test-job",
            state: "processing",
            actionType: "agent",
            actionId: "test-agent",
            status: "completed",
          },
        },
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

  describe("inputSnapshot Schema Validation", () => {
    // Full inputSnapshot object parses successfully
    it("parses event with full inputSnapshot", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const eventInput: AppendSessionEventInput = {
        sessionId,
        emittedBy: "fsm-engine",
        event: {
          type: "fsm-action",
          context: { metadata: { fsmEventType: "action" } },
          data: {
            jobName: "test-job",
            actionType: "agent",
            actionId: "researcher",
            state: "processing",
            status: "started",
            inputSnapshot: {
              task: "Research market trends",
              requestDocId: "req-123",
              config: { maxResults: 10, format: "json" },
            },
          },
        },
      };

      const appendResult = await SessionHistoryStorage.appendSessionEvent(eventInput);
      assert(appendResult.ok);

      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok);
      assert(timeline.data);

      const event = timeline.data.events[0];
      assert(event);
      assertEquals(event.type, "fsm-action");
      // Verify inputSnapshot was persisted and can be retrieved
      const data = event.data as {
        inputSnapshot?: { task?: string; requestDocId?: string; config?: Record<string, unknown> };
      };
      assert(data.inputSnapshot);
      assertEquals(data.inputSnapshot.task, "Research market trends");
      assertEquals(data.inputSnapshot.requestDocId, "req-123");
      assertEquals(data.inputSnapshot.config?.maxResults, 10);
    });

    // Partial inputSnapshot (task only) parses successfully
    it("parses event with partial inputSnapshot (task only)", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const eventInput: AppendSessionEventInput = {
        sessionId,
        emittedBy: "fsm-engine",
        event: {
          type: "fsm-action",
          context: { metadata: { fsmEventType: "action" } },
          data: {
            jobName: "test-job",
            actionType: "llm",
            actionId: "analyzer",
            state: "analyzing",
            status: "completed",
            durationMs: 1500,
            inputSnapshot: {
              task: "Analyze sentiment",
              // No requestDocId or config
            },
          },
        },
      };

      const appendResult = await SessionHistoryStorage.appendSessionEvent(eventInput);
      assert(appendResult.ok);

      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok);
      assert(timeline.data);

      const event = timeline.data.events[0];
      assert(event);
      const data = event.data as { inputSnapshot?: { task?: string; requestDocId?: string } };
      assert(data.inputSnapshot);
      assertEquals(data.inputSnapshot.task, "Analyze sentiment");
      assertEquals(data.inputSnapshot.requestDocId, undefined);
    });

    // Event without inputSnapshot parses successfully (backwards compatible)
    it("parses event without inputSnapshot (backwards compatible)", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      const eventInput: AppendSessionEventInput = {
        sessionId,
        emittedBy: "fsm-engine",
        event: {
          type: "fsm-action",
          context: { metadata: { fsmEventType: "action" } },
          data: {
            jobName: "test-job",
            actionType: "code",
            actionId: "processData",
            state: "processing",
            status: "completed",
            durationMs: 50,
            // No inputSnapshot - code actions don't have one
          },
        },
      };

      const appendResult = await SessionHistoryStorage.appendSessionEvent(eventInput);
      assert(appendResult.ok);

      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok);
      assert(timeline.data);

      const event = timeline.data.events[0];
      assert(event);
      const data = event.data as { inputSnapshot?: unknown };
      assertEquals(data.inputSnapshot, undefined);
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
        event: {
          type: "fsm-action",
          data: { jobName: "test-job", state: "idle", actionType: "emit", status: "completed" },
        },
      });

      const result = await SessionHistoryStorage.listSessions({ workspaceId: "workspace-123" });
      assert(result.ok);
      assertEquals(result.data.sessions.length, 3);
      assertEquals(result.data.sessions[0]?.sessionId, session1);
    });

    it("excludes workspaces by excludeWorkspaceIds", async () => {
      const session1 = crypto.randomUUID();
      const session2 = crypto.randomUUID();

      await SessionHistoryStorage.createSessionRecord(createMetadataInput(session1));
      await SessionHistoryStorage.createSessionRecord({
        ...createMetadataInput(session2),
        workspaceId: "atlas-conversation",
      });

      const result = await SessionHistoryStorage.listSessions({
        excludeWorkspaceIds: ["atlas-conversation"],
      });

      assert(result.ok);
      assert(result.data.sessions.every((s) => s.workspaceId !== "atlas-conversation"));
    });
  });
});
