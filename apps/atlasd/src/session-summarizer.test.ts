import type { SessionAISummary, SessionView } from "@atlas/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateSessionSummaryDeps } from "./session-summarizer.ts";
import { generateSessionSummary } from "./session-summarizer.ts";

type GenerateFn = NonNullable<GenerateSessionSummaryDeps["generateObject"]>;

/** Extract prompt string from the first mock call. */
function getPromptFromMock(mock: ReturnType<typeof vi.fn<GenerateFn>>): string {
  const call = mock.mock.calls.at(0);
  if (!call) throw new Error("Expected at least one mock call");
  const opts = call[0];
  if (typeof opts === "object" && opts !== null && "prompt" in opts) {
    return String(opts.prompt);
  }
  throw new Error("Expected call args to contain prompt");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeView(overrides?: Partial<SessionView>): SessionView {
  return {
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "ticket-digest",
    task: "Summarize Linear tickets from the past week",
    status: "completed",
    startedAt: "2026-02-15T00:00:00Z",
    completedAt: "2026-02-15T00:01:00Z",
    durationMs: 60000,
    agentBlocks: [
      {
        stepNumber: 1,
        agentName: "researcher",
        actionType: "agent",
        task: "Find Linear tickets from the past week",
        status: "completed",
        durationMs: 3200,
        toolCalls: [],
        output: { tickets: [{ id: "T-1", title: "Fix auth" }] },
      },
      {
        stepNumber: 2,
        agentName: "writer",
        actionType: "agent",
        task: "Write a summary of the tickets",
        status: "completed",
        durationMs: 8100,
        toolCalls: [],
        output: { markdown: "# Weekly Digest\n..." },
      },
      {
        stepNumber: 3,
        agentName: "publisher",
        actionType: "agent",
        task: "Publish the digest to Notion",
        status: "completed",
        durationMs: 2400,
        toolCalls: [],
        output: { url: "https://notion.so/digest-123" },
      },
    ],
    ...overrides,
  };
}

const summaryResult: SessionAISummary = {
  summary: "Published a weekly digest of 1 Linear ticket to Notion.",
  keyDetails: [
    { label: "Notion Page", value: "Weekly Digest", url: "https://notion.so/digest-123" },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateSessionSummary", () => {
  let mockGenerate: ReturnType<typeof vi.fn<GenerateFn>>;

  beforeEach(() => {
    mockGenerate = vi.fn<GenerateFn>();
  });

  it("assembles condensed step list with task descriptions in the prompt", async () => {
    mockGenerate.mockResolvedValueOnce({ object: summaryResult });
    const view = makeView();

    await generateSessionSummary(view, { generateObject: mockGenerate });

    const prompt = getPromptFromMock(mockGenerate);

    // Condensed step list includes agent names, status, and task
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("Find Linear tickets from the past week");
    expect(prompt).toContain("writer");
    expect(prompt).toContain("publisher");
  });

  it("includes session status in the prompt context", async () => {
    mockGenerate.mockResolvedValueOnce({ object: summaryResult });
    const view = makeView({ status: "failed" });

    await generateSessionSummary(view, { generateObject: mockGenerate });

    const prompt = getPromptFromMock(mockGenerate);
    expect(prompt).toContain("failed");
  });

  it("includes final step output as the deliverable in the prompt", async () => {
    mockGenerate.mockResolvedValueOnce({ object: summaryResult });
    const view = makeView();

    await generateSessionSummary(view, { generateObject: mockGenerate });

    const prompt = getPromptFromMock(mockGenerate);
    // Only the last block's output is included as the result
    expect(prompt).toContain("notion.so/digest-123");
    // Intermediate outputs are NOT included
    expect(prompt).not.toContain("Fix auth");
    expect(prompt).not.toContain("Weekly Digest");
  });

  it("returns structured summary on success", async () => {
    mockGenerate.mockResolvedValueOnce({ object: summaryResult });

    const result = await generateSessionSummary(makeView(), { generateObject: mockGenerate });

    expect(result).toEqual(summaryResult);
  });

  it("returns undefined on timeout (AbortSignal)", async () => {
    mockGenerate.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const result = await generateSessionSummary(makeView(), { generateObject: mockGenerate });

    expect(result).toBeUndefined();
  });

  it("returns undefined on API error", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("503 Service Unavailable"));

    const result = await generateSessionSummary(makeView(), { generateObject: mockGenerate });

    expect(result).toBeUndefined();
  });

  it("handles failed session with error in last block", async () => {
    const failedSummary: SessionAISummary = {
      summary: "Failed to fetch Linear tickets — auth token expired.",
      keyDetails: [],
    };
    mockGenerate.mockResolvedValueOnce({ object: failedSummary });

    const view = makeView({
      status: "failed",
      error: "Auth token expired",
      agentBlocks: [
        {
          stepNumber: 1,
          agentName: "researcher",
          actionType: "agent",
          task: "Find Linear tickets",
          status: "failed",
          durationMs: 1200,
          toolCalls: [],
          output: undefined,
          error: "Auth token expired",
        },
      ],
    });

    const result = await generateSessionSummary(view, { generateObject: mockGenerate });

    expect(result).toEqual(failedSummary);
    const prompt = getPromptFromMock(mockGenerate);
    expect(prompt).toContain("Auth token expired");
  });

  it("handles skipped session status", async () => {
    mockGenerate.mockResolvedValueOnce({
      object: { summary: "Skipped — Linear OAuth not configured.", keyDetails: [] },
    });

    const view = makeView({ status: "skipped", agentBlocks: [] });

    await generateSessionSummary(view, { generateObject: mockGenerate });

    const prompt = getPromptFromMock(mockGenerate);
    expect(prompt).toContain("skipped");
  });

  it("handles empty agentBlocks gracefully", async () => {
    const emptySummary: SessionAISummary = {
      summary: "Session skipped with no steps executed.",
      keyDetails: [],
    };
    mockGenerate.mockResolvedValueOnce({ object: emptySummary });

    const view = makeView({ status: "skipped", agentBlocks: [] });

    const result = await generateSessionSummary(view, { generateObject: mockGenerate });

    expect(result).toEqual(emptySummary);
  });
});
