import type { SessionHistoryTimeline } from "@atlas/core";
import { createStubPlatformModels } from "@atlas/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTranscriptExcerpt,
  classifyFailure,
  extractFailedStepId,
} from "./triage-classifier.ts";

// Mock the AI SDK generateObject call
const mockGenerateObject = vi.fn();
vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => mockGenerateObject(...args) }));

// Mock logger
vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("classifyFailure", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("returns null when LLM call fails", async () => {
    mockGenerateObject.mockRejectedValue(new Error("LLM service unavailable"));

    const result = await classifyFailure(
      { errorMessage: "Some error", jobId: "test-job", transcriptExcerpt: "(no events)" },
      createStubPlatformModels(),
    );

    expect(result).toBeNull();
  });
});

describe("buildTranscriptExcerpt", () => {
  it("returns placeholder for empty events", () => {
    const timeline = makeTimeline([]);
    expect(buildTranscriptExcerpt(timeline)).toBe("(no events recorded)");
  });

  it("formats FSM action events", () => {
    const timeline = makeTimeline([
      makeFSMAction("job-1", "step-1", "llm", "completed"),
      makeFSMAction("job-1", "step-2", "agent", "failed", "Something went wrong"),
    ]);

    const excerpt = buildTranscriptExcerpt(timeline);
    expect(excerpt).toContain("[fsm-action] job-1/step-1");
    expect(excerpt).toContain("status=completed");
    expect(excerpt).toContain("status=failed");
    expect(excerpt).toContain("Something went wrong");
  });

  it("formats session-finish events", () => {
    const timeline = makeTimeline([
      {
        eventId: "e1",
        sessionId: "s1",
        emittedAt: "2026-03-10T00:00:00Z",
        emittedBy: "system",
        type: "session-finish" as const,
        data: { status: "failed" as const, durationMs: 5000, failureReason: "Step step-2 failed" },
      },
    ]);

    const excerpt = buildTranscriptExcerpt(timeline);
    expect(excerpt).toContain("[session-finish]");
    expect(excerpt).toContain("status=failed");
    expect(excerpt).toContain('reason="Step step-2 failed"');
  });

  it("filters out session-start events", () => {
    const timeline = makeTimeline([
      {
        eventId: "e1",
        sessionId: "s1",
        emittedAt: "2026-03-10T00:00:00Z",
        emittedBy: "system",
        type: "session-start" as const,
        data: { status: "completed" as const },
      },
    ]);

    const excerpt = buildTranscriptExcerpt(timeline);
    expect(excerpt).toBe("(no relevant events)");
  });

  it("limits to last 20 events", () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      makeFSMAction("job-1", `step-${i}`, "llm", "completed"),
    );
    const timeline = makeTimeline(events);
    const excerpt = buildTranscriptExcerpt(timeline);
    const lines = excerpt.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
  });
});

describe("extractFailedStepId", () => {
  it("returns the last failed FSM action step", () => {
    const timeline = makeTimeline([
      makeFSMAction("job-1", "step-1", "llm", "completed"),
      makeFSMAction("job-1", "step-2", "agent", "failed", "error"),
    ]);
    expect(extractFailedStepId(timeline)).toBe("step-2");
  });

  it("returns undefined when no failed actions", () => {
    const timeline = makeTimeline([makeFSMAction("job-1", "step-1", "llm", "completed")]);
    expect(extractFailedStepId(timeline)).toBeUndefined();
  });

  it("prefers actionId over state", () => {
    const timeline = makeTimeline([
      {
        eventId: "e1",
        sessionId: "s1",
        emittedAt: "2026-03-10T00:00:00Z",
        emittedBy: "system",
        type: "fsm-action" as const,
        data: {
          jobName: "job-1",
          state: "state-name",
          actionType: "llm" as const,
          actionId: "specific-action-id",
          status: "failed" as const,
          error: "fail",
        },
      },
    ]);
    expect(extractFailedStepId(timeline)).toBe("specific-action-id");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeline(events: SessionHistoryTimeline["events"]): SessionHistoryTimeline {
  return {
    metadata: {
      sessionId: "test-session",
      workspaceId: "test-workspace",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      status: "failed",
      signal: { id: "test-signal", provider: { id: "http", name: "HTTP" } },
      availableAgents: [],
    },
    events,
  };
}

function makeFSMAction(
  jobName: string,
  state: string,
  actionType: "agent" | "llm" | "code" | "emit",
  status: "started" | "completed" | "failed",
  error?: string,
): SessionHistoryTimeline["events"][0] {
  return {
    eventId: `e-${Math.random()}`,
    sessionId: "s1",
    emittedAt: "2026-03-10T00:00:00Z",
    emittedBy: "system",
    type: "fsm-action",
    data: { jobName, state, actionType, status, error },
  };
}
