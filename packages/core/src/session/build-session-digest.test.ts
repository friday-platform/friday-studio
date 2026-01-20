import { describe, expect, it } from "vitest";
import { ReasoningResultStatus } from "../constants/supervisor-status.ts";
import {
  buildSessionDigest,
  extractArtifacts,
  extractOutputContent,
  extractPrimaryError,
} from "./build-session-digest.ts";
import type {
  SessionHistoryEvent,
  SessionHistoryMetadata,
  SessionHistoryTimeline,
} from "./history-storage.ts";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createBaseMetadata(
  overrides: Partial<SessionHistoryMetadata> = {},
): SessionHistoryMetadata {
  return {
    sessionId: "session-123",
    workspaceId: "workspace-456",
    createdAt: "2026-01-13T10:00:00.000Z",
    updatedAt: "2026-01-13T10:01:00.000Z",
    status: ReasoningResultStatus.COMPLETED,
    signal: { id: "signal-abc", provider: { id: "http", name: "HTTP" } },
    availableAgents: ["researcher"],
    ...overrides,
  };
}

function createFsmActionStarted(
  state: string,
  actionId: string,
  options: { task?: string; executionId?: string; emittedAt?: string } = {},
): SessionHistoryEvent {
  const executionId = options.executionId || `job:${actionId}:${state}`;
  return {
    eventId: crypto.randomUUID(),
    sessionId: "session-123",
    emittedAt: options.emittedAt || "2026-01-13T10:00:10.000Z",
    emittedBy: "fsm-engine",
    type: "fsm-action",
    context: { executionId },
    data: {
      jobName: "test-job",
      state,
      actionType: "agent",
      actionId,
      status: "started",
      inputSnapshot: options.task ? { task: options.task } : undefined,
    },
  };
}

function createFsmActionCompleted(
  state: string,
  actionId: string,
  options: { durationMs?: number; error?: string; executionId?: string; emittedAt?: string } = {},
): SessionHistoryEvent {
  const executionId = options.executionId || `job:${actionId}:${state}`;
  return {
    eventId: crypto.randomUUID(),
    sessionId: "session-123",
    emittedAt: options.emittedAt || "2026-01-13T10:00:20.000Z",
    emittedBy: "fsm-engine",
    type: "fsm-action",
    context: { executionId },
    data: {
      jobName: "test-job",
      state,
      actionType: "agent",
      actionId,
      status: options.error ? "failed" : "completed",
      durationMs: options.durationMs,
      error: options.error,
    },
  };
}

function createToolCall(
  executionId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  emittedAt?: string,
): SessionHistoryEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId: "session-123",
    emittedAt: emittedAt || "2026-01-13T10:00:15.000Z",
    emittedBy: "fsm-engine",
    type: "agent-tool-call",
    context: { executionId },
    data: {
      agentId: "researcher",
      executionId,
      toolCall: { type: "tool-call", toolCallId, toolName, input } as never,
    },
  };
}

function createToolResult(
  executionId: string,
  toolCallId: string,
  output: unknown,
  emittedAt?: string,
): SessionHistoryEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId: "session-123",
    emittedAt: emittedAt || "2026-01-13T10:00:16.000Z",
    emittedBy: "fsm-engine",
    type: "agent-tool-result",
    context: { executionId },
    data: {
      agentId: "researcher",
      executionId,
      toolResult: { type: "tool-result", toolCallId, toolName: "test", input: {}, output } as never,
    },
  };
}

function createSessionFinish(
  options: { status?: string; durationMs?: number; failureReason?: string; output?: unknown } = {},
): SessionHistoryEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId: "session-123",
    emittedAt: "2026-01-13T10:01:00.000Z",
    emittedBy: "session-supervisor",
    type: "session-finish",
    data: {
      status: (options.status as "completed") || ReasoningResultStatus.COMPLETED,
      durationMs: options.durationMs || 60000,
      failureReason: options.failureReason,
      output: options.output,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests - focused on behavior that matters
// ---------------------------------------------------------------------------

describe("buildSessionDigest", () => {
  it("extracts metadata (id, status, type, duration)", () => {
    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ sessionType: "task", durationMs: 5000 }),
      events: [],
    };

    const digest = buildSessionDigest(timeline);

    expect(digest.id).toEqual("session-123");
    expect(digest.status).toEqual(ReasoningResultStatus.COMPLETED);
    expect(digest.type).toEqual("task");
    expect(digest.durationMs).toEqual(5000);
  });

  it("extracts input with fallback chain: intent -> body.task -> summary", () => {
    // Test the fallback chain in one test - intent wins
    const withIntent: SessionHistoryTimeline = {
      metadata: createBaseMetadata({
        signalPayload: { intent: "Research AI", body: { task: "ignored" } },
        summary: "also ignored",
      }),
      events: [],
    };
    expect(buildSessionDigest(withIntent).input.task).toEqual("Research AI");

    // body.task fallback
    const withBodyTask: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ signalPayload: { body: { task: "Process doc" } } }),
      events: [],
    };
    expect(buildSessionDigest(withBodyTask).input.task).toEqual("Process doc");

    // summary fallback
    const withSummary: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ summary: "Summary fallback", signalPayload: {} }),
      events: [],
    };
    expect(buildSessionDigest(withSummary).input.task).toEqual("Summary fallback");
  });

  it("extracts output from session-finish event or metadata fallback", () => {
    const output = { results: [{ step: 0, success: true }] };

    // From event
    const withEvent: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [createSessionFinish({ output })],
    };
    expect(buildSessionDigest(withEvent).output).toEqual(output);

    // Fallback to metadata
    const withMetadata: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ output: { fallback: true } }),
      events: [],
    };
    expect(buildSessionDigest(withMetadata).output).toEqual({ fallback: true });
  });

  it("builds steps from fsm-action events with correct ordering", () => {
    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [
        // Out of order - step_1 emitted first
        createFsmActionStarted("step_1", "formatter", { emittedAt: "2026-01-13T10:00:20.000Z" }),
        createFsmActionStarted("step_0", "researcher", {
          task: "Research AI",
          emittedAt: "2026-01-13T10:00:10.000Z",
        }),
        createFsmActionCompleted("step_0", "researcher", { durationMs: 5000 }),
        createFsmActionCompleted("step_1", "formatter"),
        // Non-step states should be skipped
        createFsmActionStarted("idle", "system"),
        createFsmActionStarted("completed", "system"),
      ],
    };

    const digest = buildSessionDigest(timeline);

    // Only step_* states, ordered by step number
    expect(digest.steps.length).toEqual(2);
    expect(digest.steps[0]?.step).toEqual(1);
    expect(digest.steps[0]?.agent).toEqual("researcher");
    expect(digest.steps[0]?.task).toEqual("Research AI");
    expect(digest.steps[0]?.durationMs).toEqual(5000);
    expect(digest.steps[1]?.step).toEqual(2);
    expect(digest.steps[1]?.agent).toEqual("formatter");
  });

  it("tracks step status: completed, failed, in-progress", () => {
    const execId = "job:researcher:step_0";
    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [
        // Completed step
        createFsmActionStarted("step_0", "researcher", { executionId: execId }),
        createFsmActionCompleted("step_0", "researcher", { executionId: execId }),
        // Failed step
        createFsmActionStarted("step_1", "formatter", { executionId: "job:formatter:step_1" }),
        createFsmActionCompleted("step_1", "formatter", {
          executionId: "job:formatter:step_1",
          error: "Connection timeout",
        }),
        // In-progress step (no completion event)
        createFsmActionStarted("step_2", "writer"),
      ],
    };

    const digest = buildSessionDigest(timeline);

    expect(digest.steps[0]?.status).toEqual("completed");
    expect(digest.steps[1]?.status).toEqual("failed");
    expect(digest.steps[1]?.error).toEqual("Connection timeout");
    expect(digest.steps[2]?.status).toEqual("in-progress");
  });

  it("pairs tool calls with results by executionId and toolCallId", () => {
    const execId = "job:researcher:step_0";
    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [
        createFsmActionStarted("step_0", "researcher", { executionId: execId }),
        // Multiple tool calls - some with results, some pending
        createToolCall(execId, "tc-1", "web_search", { query: "AI startups" }),
        createToolCall(execId, "tc-2", "read_url", { url: "https://example.com" }),
        createToolCall(execId, "tc-3", "pending_tool", { data: "test" }),
        createToolResult(execId, "tc-1", "Found 12 results..."),
        createToolResult(execId, "tc-2", "Page content"),
        // tc-3 has no result (pending)
        createFsmActionCompleted("step_0", "researcher", { executionId: execId }),
      ],
    };

    const digest = buildSessionDigest(timeline);
    const toolCalls = digest.steps[0]?.toolCalls;

    expect(toolCalls?.length).toEqual(3);
    expect(toolCalls?.[0]?.toolCallId).toEqual("tc-1");
    expect(toolCalls?.[0]?.tool).toEqual("web_search");
    expect(toolCalls?.[0]?.result).toEqual("Found 12 results...");
    expect(toolCalls?.[1]?.toolCallId).toEqual("tc-2");
    expect(toolCalls?.[1]?.tool).toEqual("read_url");
    expect(toolCalls?.[1]?.result).toEqual("Page content");
    expect(toolCalls?.[2]?.toolCallId).toEqual("tc-3");
    expect(toolCalls?.[2]?.tool).toEqual("pending_tool");
    expect(toolCalls?.[2]?.result).toEqual(undefined); // Pending
  });

  it("collects errors from failed steps and session-level failures", () => {
    const execId = "job:researcher:step_0";
    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [
        createFsmActionStarted("step_0", "researcher", { executionId: execId }),
        createFsmActionCompleted("step_0", "researcher", {
          error: "API rate limit exceeded",
          executionId: execId,
        }),
        createSessionFinish({
          status: ReasoningResultStatus.FAILED,
          failureReason: "Max retries exceeded",
        }),
      ],
    };

    const digest = buildSessionDigest(timeline);

    expect(digest.errors.length).toEqual(2);
    expect(digest.errors[0]?.step).toEqual(1); // Step-level error
    expect(digest.errors[0]?.error).toEqual("API rate limit exceeded");
    expect(digest.errors[1]?.step).toEqual(0); // Session-level error
    expect(digest.errors[1]?.error).toEqual("Max retries exceeded");
  });

  it("builds complete digest from realistic multi-step session", () => {
    const exec0 = "job:researcher:step_0";
    const exec1 = "job:formatter:step_1";

    const timeline: SessionHistoryTimeline = {
      metadata: createBaseMetadata({
        sessionType: "task",
        signalPayload: { intent: "Research AI startups and format as digest" },
        durationMs: 17720,
      }),
      events: [
        // Step 0: Research (success)
        createFsmActionStarted("step_0", "researcher", {
          task: "Research latest AI startup funding",
          executionId: exec0,
        }),
        createToolCall(exec0, "tc-1", "web_search", { query: "AI startup funding 2026" }),
        createToolResult(exec0, "tc-1", "Found 12 results..."),
        createFsmActionCompleted("step_0", "researcher", { durationMs: 11900, executionId: exec0 }),

        // Step 1: Format (failed)
        createFsmActionStarted("step_1", "formatter", {
          task: "Format research into email digest",
          executionId: exec1,
        }),
        createToolCall(exec1, "tc-2", "write_file", { path: "/tmp/digest.md" }),
        createFsmActionCompleted("step_1", "formatter", {
          durationMs: 5820,
          error: "Cannot complete: input was empty string",
          executionId: exec1,
        }),

        // Session finish
        createSessionFinish({
          status: ReasoningResultStatus.FAILED,
          durationMs: 17720,
          failureReason: "Step 2 failed after 3 retries",
          output: {
            results: [
              { step: 0, agent: "researcher", success: true },
              { step: 1, agent: "formatter", success: false },
            ],
          },
        }),
      ],
    };

    const digest = buildSessionDigest(timeline);

    // Core structure
    expect(digest.id).toEqual("session-123");
    expect(digest.type).toEqual("task");
    expect(digest.durationMs).toEqual(17720);
    expect(digest.input.task).toEqual("Research AI startups and format as digest");

    // Steps with tool calls
    expect(digest.steps.length).toEqual(2);
    expect(digest.steps[0]?.agent).toEqual("researcher");
    expect(digest.steps[0]?.status).toEqual("completed");
    expect(digest.steps[0]?.toolCalls?.[0]?.tool).toEqual("web_search");
    expect(digest.steps[1]?.agent).toEqual("formatter");
    expect(digest.steps[1]?.status).toEqual("failed");
    expect(digest.steps[1]?.toolCalls?.[0]?.result).toEqual(undefined); // No result before failure

    // Errors collected
    expect(digest.errors.length).toEqual(2);

    // Output preserved
    expect((digest.output as Record<string, unknown>).results).toEqual([
      { step: 0, agent: "researcher", success: true },
      { step: 1, agent: "formatter", success: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests for extraction helpers
// ---------------------------------------------------------------------------

describe("extractOutputContent", () => {
  it("returns undefined for non-array output", () => {
    expect(extractOutputContent(null)).toEqual(undefined);
    expect(extractOutputContent(undefined)).toEqual(undefined);
    expect(extractOutputContent("string")).toEqual(undefined);
    expect(extractOutputContent({ key: "value" })).toEqual(undefined);
  });

  it("returns undefined for empty array", () => {
    expect(extractOutputContent([])).toEqual(undefined);
  });

  it("extracts content from last step's output", () => {
    const output = [
      { output: { content: "First step response" } },
      { output: { content: "Final response from LLM" } },
    ];
    expect(extractOutputContent(output)).toEqual("Final response from LLM");
  });

  it("returns undefined when last step has no content", () => {
    const output = [
      { output: { content: "Has content" } },
      { output: { toolResults: [] } }, // No content field
    ];
    expect(extractOutputContent(output)).toEqual(undefined);
  });
});

describe("extractArtifacts", () => {
  it("returns empty array for non-array output", () => {
    expect(extractArtifacts(null)).toEqual([]);
    expect(extractArtifacts(undefined)).toEqual([]);
    expect(extractArtifacts("string")).toEqual([]);
  });

  it("extracts artifacts from artifacts_create tool results", () => {
    const output = [
      {
        output: {
          toolResults: [
            {
              toolName: "artifacts_create",
              output: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ id: "art-1", title: "Report", type: "document" }),
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    expect(extractArtifacts(output)).toEqual([{ id: "art-1", title: "Report", type: "document" }]);
  });

  it("extracts multiple artifacts across steps", () => {
    const output = [
      {
        output: {
          toolResults: [
            {
              toolName: "artifacts_create",
              output: {
                content: [{ type: "text", text: JSON.stringify({ id: "art-1", title: "Doc 1" }) }],
              },
            },
          ],
        },
      },
      {
        output: {
          toolResults: [
            {
              toolName: "artifacts_create",
              output: {
                content: [{ type: "text", text: JSON.stringify({ id: "art-2", title: "Doc 2" }) }],
              },
            },
          ],
        },
      },
    ];
    expect(extractArtifacts(output)).toEqual([
      { id: "art-1", title: "Doc 1", type: undefined },
      { id: "art-2", title: "Doc 2", type: undefined },
    ]);
  });

  it("ignores non-artifacts_create tool results", () => {
    const output = [
      {
        output: {
          toolResults: [
            { toolName: "web_search", output: { content: [{ type: "text", text: "results" }] } },
            {
              toolName: "read_file",
              output: { content: [{ type: "text", text: "file content" }] },
            },
          ],
        },
      },
    ];
    expect(extractArtifacts(output)).toEqual([]);
  });
});

describe("extractPrimaryError", () => {
  it("returns undefined for non-failed status", () => {
    expect(extractPrimaryError([{ step: 1, error: "Error" }], "completed")).toEqual(undefined);
    expect(extractPrimaryError([{ step: 1, error: "Error" }], "partial")).toEqual(undefined);
  });

  it("returns undefined for empty errors array", () => {
    expect(extractPrimaryError([], "failed")).toEqual(undefined);
  });

  it("prefers step-level error over session-level error", () => {
    const errors = [
      { step: 0, error: "Session failed" },
      { step: 1, error: "Step 1 timeout" },
    ];
    expect(extractPrimaryError(errors, "failed")).toEqual("Step 1 timeout");
  });

  it("falls back to session-level error when no step errors", () => {
    const errors = [{ step: 0, error: "Max retries exceeded" }];
    expect(extractPrimaryError(errors, "failed")).toEqual("Max retries exceeded");
  });
});
