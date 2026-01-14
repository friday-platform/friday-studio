import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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

    assertEquals(digest.id, "session-123");
    assertEquals(digest.status, ReasoningResultStatus.COMPLETED);
    assertEquals(digest.type, "task");
    assertEquals(digest.durationMs, 5000);
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
    assertEquals(buildSessionDigest(withIntent).input.task, "Research AI");

    // body.task fallback
    const withBodyTask: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ signalPayload: { body: { task: "Process doc" } } }),
      events: [],
    };
    assertEquals(buildSessionDigest(withBodyTask).input.task, "Process doc");

    // summary fallback
    const withSummary: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ summary: "Summary fallback", signalPayload: {} }),
      events: [],
    };
    assertEquals(buildSessionDigest(withSummary).input.task, "Summary fallback");
  });

  it("extracts output from session-finish event or metadata fallback", () => {
    const output = { results: [{ step: 0, success: true }] };

    // From event
    const withEvent: SessionHistoryTimeline = {
      metadata: createBaseMetadata(),
      events: [createSessionFinish({ output })],
    };
    assertEquals(buildSessionDigest(withEvent).output, output);

    // Fallback to metadata
    const withMetadata: SessionHistoryTimeline = {
      metadata: createBaseMetadata({ output: { fallback: true } }),
      events: [],
    };
    assertEquals(buildSessionDigest(withMetadata).output, { fallback: true });
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
    assertEquals(digest.steps.length, 2);
    assertEquals(digest.steps[0]?.step, 1);
    assertEquals(digest.steps[0]?.agent, "researcher");
    assertEquals(digest.steps[0]?.task, "Research AI");
    assertEquals(digest.steps[0]?.durationMs, 5000);
    assertEquals(digest.steps[1]?.step, 2);
    assertEquals(digest.steps[1]?.agent, "formatter");
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

    assertEquals(digest.steps[0]?.status, "completed");
    assertEquals(digest.steps[1]?.status, "failed");
    assertEquals(digest.steps[1]?.error, "Connection timeout");
    assertEquals(digest.steps[2]?.status, "in-progress");
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

    assertEquals(toolCalls?.length, 3);
    assertEquals(toolCalls?.[0]?.toolCallId, "tc-1");
    assertEquals(toolCalls?.[0]?.tool, "web_search");
    assertEquals(toolCalls?.[0]?.result, "Found 12 results...");
    assertEquals(toolCalls?.[1]?.toolCallId, "tc-2");
    assertEquals(toolCalls?.[1]?.tool, "read_url");
    assertEquals(toolCalls?.[1]?.result, "Page content");
    assertEquals(toolCalls?.[2]?.toolCallId, "tc-3");
    assertEquals(toolCalls?.[2]?.tool, "pending_tool");
    assertEquals(toolCalls?.[2]?.result, undefined); // Pending
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

    assertEquals(digest.errors.length, 2);
    assertEquals(digest.errors[0]?.step, 1); // Step-level error
    assertEquals(digest.errors[0]?.error, "API rate limit exceeded");
    assertEquals(digest.errors[1]?.step, 0); // Session-level error
    assertEquals(digest.errors[1]?.error, "Max retries exceeded");
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
    assertEquals(digest.id, "session-123");
    assertEquals(digest.type, "task");
    assertEquals(digest.durationMs, 17720);
    assertEquals(digest.input.task, "Research AI startups and format as digest");

    // Steps with tool calls
    assertEquals(digest.steps.length, 2);
    assertEquals(digest.steps[0]?.agent, "researcher");
    assertEquals(digest.steps[0]?.status, "completed");
    assertEquals(digest.steps[0]?.toolCalls?.[0]?.tool, "web_search");
    assertEquals(digest.steps[1]?.agent, "formatter");
    assertEquals(digest.steps[1]?.status, "failed");
    assertEquals(digest.steps[1]?.toolCalls?.[0]?.result, undefined); // No result before failure

    // Errors collected
    assertEquals(digest.errors.length, 2);

    // Output preserved
    assertEquals((digest.output as Record<string, unknown>).results, [
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
    assertEquals(extractOutputContent(null), undefined);
    assertEquals(extractOutputContent(undefined), undefined);
    assertEquals(extractOutputContent("string"), undefined);
    assertEquals(extractOutputContent({ key: "value" }), undefined);
  });

  it("returns undefined for empty array", () => {
    assertEquals(extractOutputContent([]), undefined);
  });

  it("extracts content from last step's output", () => {
    const output = [
      { output: { content: "First step response" } },
      { output: { content: "Final response from LLM" } },
    ];
    assertEquals(extractOutputContent(output), "Final response from LLM");
  });

  it("returns undefined when last step has no content", () => {
    const output = [
      { output: { content: "Has content" } },
      { output: { toolResults: [] } }, // No content field
    ];
    assertEquals(extractOutputContent(output), undefined);
  });
});

describe("extractArtifacts", () => {
  it("returns empty array for non-array output", () => {
    assertEquals(extractArtifacts(null), []);
    assertEquals(extractArtifacts(undefined), []);
    assertEquals(extractArtifacts("string"), []);
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
    assertEquals(extractArtifacts(output), [{ id: "art-1", title: "Report", type: "document" }]);
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
    assertEquals(extractArtifacts(output), [
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
    assertEquals(extractArtifacts(output), []);
  });
});

describe("extractPrimaryError", () => {
  it("returns undefined for non-failed status", () => {
    assertEquals(extractPrimaryError([{ step: 1, error: "Error" }], "completed"), undefined);
    assertEquals(extractPrimaryError([{ step: 1, error: "Error" }], "partial"), undefined);
  });

  it("returns undefined for empty errors array", () => {
    assertEquals(extractPrimaryError([], "failed"), undefined);
  });

  it("prefers step-level error over session-level error", () => {
    const errors = [
      { step: 0, error: "Session failed" },
      { step: 1, error: "Step 1 timeout" },
    ];
    assertEquals(extractPrimaryError(errors, "failed"), "Step 1 timeout");
  });

  it("falls back to session-level error when no step errors", () => {
    const errors = [{ step: 0, error: "Max retries exceeded" }];
    assertEquals(extractPrimaryError(errors, "failed"), "Max retries exceeded");
  });
});
