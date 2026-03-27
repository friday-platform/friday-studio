import type { SessionHistoryTimeline } from "@atlas/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockClassifyFailure = vi.fn();
const mockBuildTranscriptExcerpt = vi.fn();
const mockExtractFailedStepId = vi.fn();
const mockParseResult = vi.fn();
const mockPatch = vi.fn<(arg: unknown) => Promise<Record<string, unknown>>>().mockResolvedValue({});

vi.mock("./triage-classifier.ts", () => ({
  buildTranscriptExcerpt: (...args: unknown[]) => mockBuildTranscriptExcerpt(...args),
  classifyFailure: (...args: unknown[]) => mockClassifyFailure(...args),
  extractFailedStepId: (...args: unknown[]) => mockExtractFailedStepId(...args),
  TriageClassification: { EXTERNAL: "EXTERNAL", WORKSPACE: "WORKSPACE" },
}));

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: { ":workspaceId": { metadata: { $patch: (arg: unknown) => mockPatch(arg) } } },
  },
  parseResult: (...args: unknown[]) => mockParseResult(...args),
}));

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import type { ImprovementLoopInput, ImproverAgentResult } from "./improvement-loop.ts";
import { runImprovementLoop } from "./improvement-loop.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyTimeline: SessionHistoryTimeline = {
  metadata: {
    sessionId: "s1",
    workspaceId: "ws-123",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "failed",
    signal: { id: "sig-1", provider: { id: "cron", name: "Cron" } },
    availableAgents: [],
  },
  events: [],
};

function makeInput(overrides?: Partial<ImprovementLoopInput>): ImprovementLoopInput {
  return {
    workspaceId: "ws-123",
    sessionId: "session-456",
    jobName: "analyze-job",
    errorMessage: "Tool 'search-web' not found",
    blueprintArtifactId: "artifact-789",
    timeline: emptyTimeline,
    invokeImprover: vi
      .fn<(input: unknown) => Promise<ImproverAgentResult>>()
      .mockResolvedValue({
        ok: true,
        data: {
          artifactId: "artifact-789",
          revision: 2,
          summary: "Fixed tool reference",
          changedFields: ["jobs[0].steps[0].description"],
        },
      }),
    ...overrides,
  };
}

function setupTriageWorkspace(reasoning = "Agent used wrong tool") {
  mockBuildTranscriptExcerpt.mockReturnValue("[tool-call] search-web(...)");
  mockExtractFailedStepId.mockReturnValue("step-1");
  mockClassifyFailure.mockResolvedValue({ classification: "WORKSPACE", reasoning });
}

function setupTriageExternal(reasoning = "API rate limit hit") {
  mockBuildTranscriptExcerpt.mockReturnValue("[tool-call] fetch(...)");
  mockExtractFailedStepId.mockReturnValue("step-1");
  mockClassifyFailure.mockResolvedValue({ classification: "EXTERNAL", reasoning });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runImprovementLoop", () => {
  beforeEach(() => {
    mockClassifyFailure.mockReset();
    mockBuildTranscriptExcerpt.mockReset();
    mockExtractFailedStepId.mockReset();
    mockParseResult.mockReset();
    mockPatch.mockReset().mockResolvedValue({});
  });

  it("runs full pipeline for WORKSPACE classification", async () => {
    setupTriageWorkspace();
    mockParseResult.mockResolvedValue({ ok: true });

    const input = makeInput();
    await runImprovementLoop(input);

    // Triage was called with correct args
    expect(mockClassifyFailure).toHaveBeenCalledOnce();
    expect(mockClassifyFailure).toHaveBeenCalledWith({
      errorMessage: "Tool 'search-web' not found",
      jobId: "analyze-job",
      failedStepId: "step-1",
      transcriptExcerpt: "[tool-call] search-web(...)",
    });

    // Improver was invoked with correct args
    expect(input.invokeImprover).toHaveBeenCalledOnce();
    expect(input.invokeImprover).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-789",
        workspaceId: "ws-123",
        jobId: "analyze-job",
        failedStepId: "step-1",
        errorMessage: "Tool 'search-web' not found",
        triageReasoning: "Agent used wrong tool",
      }),
    );

    // Metadata was patched with pending revision
    expect(mockPatch).toHaveBeenCalledOnce();
    expect(mockPatch).toHaveBeenCalledWith({
      param: { workspaceId: "ws-123" },
      json: {
        pendingRevision: expect.objectContaining({
          artifactId: "artifact-789",
          revision: 2,
          summary: "Fixed tool reference",
          triageReasoning: "Agent used wrong tool",
          createdAt: expect.any(String),
        }),
      },
    });
  });

  it("skips improver for EXTERNAL classification", async () => {
    setupTriageExternal();

    const input = makeInput();
    await runImprovementLoop(input);

    expect(mockClassifyFailure).toHaveBeenCalledOnce();
    expect(input.invokeImprover).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("skips when triage returns null", async () => {
    mockBuildTranscriptExcerpt.mockReturnValue("");
    mockExtractFailedStepId.mockReturnValue(undefined);
    mockClassifyFailure.mockResolvedValue(null);

    const input = makeInput();
    await runImprovementLoop(input);

    expect(input.invokeImprover).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("stops when improver returns error", async () => {
    setupTriageWorkspace();
    const input = makeInput({
      invokeImprover: vi
        .fn<(input: unknown) => Promise<ImproverAgentResult>>()
        .mockResolvedValue({ ok: false, error: "LLM unavailable" }),
    });

    await runImprovementLoop(input);

    expect(input.invokeImprover).toHaveBeenCalledOnce();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("does not propagate errors from any pipeline stage", async () => {
    // Transcript build throws
    mockBuildTranscriptExcerpt.mockImplementation(() => {
      throw new Error("Transcript build failed");
    });
    await runImprovementLoop(makeInput());

    // Triage throws
    mockBuildTranscriptExcerpt.mockReset().mockReturnValue("transcript");
    mockExtractFailedStepId.mockReturnValue(undefined);
    mockClassifyFailure.mockRejectedValue(new Error("LLM timeout"));
    await runImprovementLoop(makeInput());

    // Improver throws
    setupTriageWorkspace();
    await runImprovementLoop(
      makeInput({ invokeImprover: vi.fn().mockRejectedValue(new Error("Agent crashed")) }),
    );
  });
});
