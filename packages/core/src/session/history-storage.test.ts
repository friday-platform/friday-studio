import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { join } from "@std/path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
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
      expect(createResult.data.events).toHaveLength(0);

      const metadataResult = await SessionHistoryStorage.getSessionMetadata(sessionId);
      assert(metadataResult.ok);
      expect(metadataResult.data).toBeDefined();
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
      assert(timelineResult.ok && timelineResult.data);
      expect(timelineResult.data.events).toHaveLength(1);
    });

    // Missing sessions return null, not error
    it("returns null for non-existent session", async () => {
      const result = await SessionHistoryStorage.getSessionMetadata(crypto.randomUUID());
      expect(result).toMatchObject({ ok: true, data: null });
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
      expect(appendResult).toMatchObject({ ok: true, data: { emittedAt: customTimestamp } });

      const timelineResult = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timelineResult.ok && timelineResult.data);
      expect(timelineResult.data.events[0]).toMatchObject({ emittedAt: customTimestamp });
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
      expect(results.every((r) => r.ok)).toBe(true);

      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok && timeline.data);
      expect(timeline.data.events).toHaveLength(5);
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
      expect(results.every((r) => r.ok)).toBe(true);

      const metadata = await SessionHistoryStorage.getSessionMetadata(sessionId);
      assert(metadata.ok && metadata.data);
      // Title should be one of the values we wrote, not garbage
      expect(titles).toContain(metadata.data.title ?? "");
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
      assert(finalSession.ok && finalSession.data);
      expect(finalSession.data.events).toHaveLength(1);
      expect(finalSession.data.metadata.createdAt).toBe(result1.data.createdAt);
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
      assert(timeline.ok && timeline.data);

      expect(timeline.data.events[0]).toMatchObject({
        type: "fsm-action",
        data: {
          inputSnapshot: {
            task: "Research market trends",
            requestDocId: "req-123",
            config: { maxResults: 10 },
          },
        },
      });
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
      assert(timeline.ok && timeline.data && timeline.data.events[0]);

      expect(timeline.data.events[0]).toMatchObject({
        data: { inputSnapshot: { task: "Analyze sentiment" } },
      });
      const data = timeline.data.events[0].data as { inputSnapshot?: { requestDocId?: string } };
      expect(data.inputSnapshot?.requestDocId).toBeUndefined();
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
      assert(timeline.ok && timeline.data && timeline.data.events[0]);

      const data = timeline.data.events[0].data as { inputSnapshot?: unknown };
      expect(data.inputSnapshot).toBeUndefined();
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
      expect(result.data.sessions).toHaveLength(2);
      expect(result.data.sessions.every((s) => s.workspaceId === "workspace-123")).toBe(true);
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
      expect(result.data.sessions).toHaveLength(3);
      expect(result.data.sessions[0]).toMatchObject({ sessionId: session1 });
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
      expect(result.data.sessions.every((s) => s.workspaceId !== "atlas-conversation")).toBe(true);
    });
  });

  describe("JSONL format", () => {
    // Events stored as append-only JSONL, not embedded in metadata JSON
    it("stores events in separate .jsonl file", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      await SessionHistoryStorage.appendSessionEvent({
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
      });

      await SessionHistoryStorage.appendSessionEvent({
        sessionId,
        emittedBy: "test",
        event: {
          type: "fsm-action",
          data: { jobName: "test-job", state: "done", actionType: "emit", status: "completed" },
        },
      });

      // Verify the .jsonl file has one JSON object per line
      const eventsFile = join(testDir, "sessions", `${sessionId}.jsonl`);
      const content = await readFile(eventsFile, "utf-8");
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(2);

      // Each line is valid JSON with expected state
      expect(JSON.parse(lines[0] ?? "")).toHaveProperty("data.state", "processing");
      expect(JSON.parse(lines[1] ?? "")).toHaveProperty("data.state", "done");

      // Metadata file should NOT contain events array
      const metaFile = join(testDir, "sessions", `${sessionId}.json`);
      const metaContent = JSON.parse(await readFile(metaFile, "utf-8"));
      expect(metaContent).not.toHaveProperty("events");
    });

    // Metadata updates don't touch the events file
    it("metadata updates do not rewrite events", async () => {
      const sessionId = crypto.randomUUID();
      await SessionHistoryStorage.createSessionRecord(createMetadataInput(sessionId));

      await SessionHistoryStorage.appendSessionEvent({
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
      });

      // Update metadata (title)
      await SessionHistoryStorage.updateSessionTitle(sessionId, "Updated Title");

      // Events file unchanged - still has 1 event
      const eventsFile = join(testDir, "sessions", `${sessionId}.jsonl`);
      const content = await readFile(eventsFile, "utf-8");
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(1);

      // Timeline still works
      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok && timeline.data);
      expect(timeline.data.events).toHaveLength(1);
      expect(timeline.data.metadata.title).toBe("Updated Title");
    });
  });

  describe("Backwards compatibility", () => {
    // Old single-file format (events embedded in JSON) still readable
    it("reads legacy single-file format with embedded events", async () => {
      const sessionId = crypto.randomUUID();
      const sessionsDir = join(testDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Write a legacy-format file (metadata + events in one JSON)
      const legacySession = {
        sessionId,
        workspaceId: "workspace-123",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        status: "completed",
        signal: { id: "signal-abc", provider: { id: "timer", name: "Timer" } },
        availableAgents: ["researcher"],
        events: [
          {
            eventId: crypto.randomUUID(),
            sessionId,
            emittedAt: "2024-01-01T00:00:30.000Z",
            emittedBy: "workspace-runtime",
            type: "fsm-action",
            data: {
              jobName: "test-job",
              state: "processing",
              actionType: "agent",
              actionId: "researcher",
              status: "completed",
              durationMs: 500,
            },
          },
        ],
      };

      await writeFile(
        join(sessionsDir, `${sessionId}.json`),
        JSON.stringify(legacySession, null, 2),
        "utf-8",
      );

      // Should read metadata from legacy format
      const metaResult = await SessionHistoryStorage.getSessionMetadata(sessionId);
      assert(metaResult.ok && metaResult.data);
      expect(metaResult.data.sessionId).toBe(sessionId);
      expect(metaResult.data.workspaceId).toBe("workspace-123");

      // Should read events from legacy format
      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok && timeline.data);
      expect(timeline.data.events).toHaveLength(1);
      expect(timeline.data.events[0]).toMatchObject({
        type: "fsm-action",
        data: { jobName: "test-job", actionId: "researcher" },
      });

      // Should appear in list
      const listResult = await SessionHistoryStorage.listSessions({ workspaceId: "workspace-123" });
      assert(listResult.ok);
      expect(listResult.data.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    });

    // Appending to a legacy session migrates to new format
    it("appending to legacy session creates .jsonl file", async () => {
      const sessionId = crypto.randomUUID();
      const sessionsDir = join(testDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Write a legacy-format file
      const legacySession = {
        sessionId,
        workspaceId: "workspace-123",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        status: "partial",
        signal: { id: "signal-abc", provider: { id: "timer", name: "Timer" } },
        availableAgents: ["researcher"],
        events: [
          {
            eventId: crypto.randomUUID(),
            sessionId,
            emittedAt: "2024-01-01T00:00:30.000Z",
            emittedBy: "workspace-runtime",
            type: "fsm-action",
            data: {
              jobName: "test-job",
              state: "step_0",
              actionType: "agent",
              actionId: "researcher",
              status: "completed",
              durationMs: 500,
            },
          },
        ],
      };

      await writeFile(
        join(sessionsDir, `${sessionId}.json`),
        JSON.stringify(legacySession, null, 2),
        "utf-8",
      );

      // Append a new event
      const appendResult = await SessionHistoryStorage.appendSessionEvent({
        sessionId,
        emittedBy: "test",
        event: {
          type: "fsm-action",
          data: {
            jobName: "test-job",
            state: "step_1",
            actionType: "agent",
            actionId: "researcher",
            status: "started",
          },
        },
      });
      assert(appendResult.ok);

      // Should now have both old and new events
      const timeline = await SessionHistoryStorage.loadSessionTimeline(sessionId);
      assert(timeline.ok && timeline.data);
      expect(timeline.data.events).toHaveLength(2);
      expect(timeline.data.events[0]?.data).toMatchObject({ state: "step_0" });
      expect(timeline.data.events[1]?.data).toMatchObject({ state: "step_1" });
    });
  });
});
