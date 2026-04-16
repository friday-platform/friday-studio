import { type WorkspaceBlueprint, WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import { beforeEach, describe, expect, it, type MockedFunction, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockGenerateObject = vi.fn();
const mockParseResult = vi.fn();
const mockPut = vi.fn();

vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => mockGenerateObject(...args) }));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: vi.fn((id: string) => ({ modelId: id })) },
  traceModel: vi.fn((m: unknown) => m),
}));

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("@atlas/agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@atlas/agent-sdk")>("@atlas/agent-sdk");
  return {
    ...actual,
    repairJson: vi.fn(),
    createAgent: vi.fn((config: Record<string, unknown>) => ({
      ...config,
      metadata: {
        id: config.id,
        displayName: config.displayName,
        version: config.version,
        description: config.description,
        expertise: config.expertise,
      },
      execute: (input: unknown, context: unknown) => {
        if (typeof config.handler === "function") {
          return (config.handler as (input: unknown, ctx: unknown) => Promise<unknown>)(
            input,
            context,
          );
        }
        throw new Error("No handler provided to createAgent mock");
      },
    })),
    ok: vi.fn((data: unknown) => ({ ok: true, data })),
    err: vi.fn((error: unknown) => ({ ok: false, error })),
  };
});

vi.mock("@atlas/client/v2", () => ({
  client: {
    artifactsStorage: { ":id": { $get: vi.fn(), $put: (...args: unknown[]) => mockPut(...args) } },
  },
  parseResult: (...args: unknown[]) => mockParseResult(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { workspaceImproverAgent } from "./workspace-improver.agent.ts";

// Wrap agent execute to accept object input (JSON-serializes like the daemon does)
const handler = (input: Record<string, unknown>, ctx: TestContext) =>
  workspaceImproverAgent.execute(JSON.stringify(input), ctx);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlueprint(overrides?: Partial<WorkspaceBlueprint>): WorkspaceBlueprint {
  return WorkspaceBlueprintSchema.parse({
    workspace: { name: "test-workspace", purpose: "Test purpose" },
    signals: [
      {
        id: "on-schedule",
        name: "On Schedule",
        title: "Runs on schedule",
        signalType: "schedule",
        description: "Triggers every hour",
      },
    ],
    agents: [
      {
        id: "analyzer",
        name: "Analyzer",
        description: "Analyzes data",
        capabilities: ["analysis"],
      },
    ],
    jobs: [
      {
        id: "analyze-job",
        name: "Analyze Job",
        title: "Analyze",
        triggerSignalId: "on-schedule",
        steps: [
          {
            id: "step-1",
            agentId: "analyzer",
            description: "Run analysis",
            depends_on: [],
            executionType: "llm",
            executionRef: "analyzer",
          },
        ],
        documentContracts: [],
        prepareMappings: [],
      },
    ],
    ...overrides,
  });
}

function makeArtifactResponse(blueprint: WorkspaceBlueprint, revision = 1) {
  return {
    ok: true,
    data: {
      artifact: {
        id: "artifact-123",
        type: "workspace-plan",
        revision,
        revisionMessage: revision > 1 ? `Revision ${revision} changes` : undefined,
        data: { type: "workspace-plan", version: 2, data: blueprint },
      },
    },
  };
}

const defaultInput = {
  artifactId: "artifact-123",
  workspaceId: "workspace-456",
  workspaceName: "My Test Workspace",
  jobId: "analyze-job",
  failedStepId: "step-1",
  errorMessage: "Tool 'search-web' not found in available tools",
  triageReasoning: "Agent used wrong tool because the prompt didn't specify the correct one",
  transcriptExcerpt:
    '[tool-call] search-web({"query": "test"})\n[fsm-action] analyze-job/step-1 (llm) status=failed',
};

interface TestContext {
  logger: {
    info: MockedFunction<(...args: unknown[]) => void>;
    warn: MockedFunction<(...args: unknown[]) => void>;
    error: MockedFunction<(...args: unknown[]) => void>;
    debug: MockedFunction<(...args: unknown[]) => void>;
    trace: MockedFunction<(...args: unknown[]) => void>;
    fatal: MockedFunction<(...args: unknown[]) => void>;
    child: MockedFunction<(...args: unknown[]) => TestContext["logger"]>;
  };
  stream: {
    emit: MockedFunction<(event: unknown) => void>;
    end: MockedFunction<() => void>;
    error: MockedFunction<(err: unknown) => void>;
  };
  session: { sessionId: string; workspaceId: string };
  abortSignal: undefined;
  tools: Record<string, never>;
  env: Record<string, never>;
  // Allow additional properties for AgentContext compatibility
  [key: string]: unknown;
}

function makeContext(): TestContext {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    },
    stream: { emit: vi.fn(), end: vi.fn(), error: vi.fn() },
    session: { sessionId: "s1", workspaceId: "w1" },
    abortSignal: undefined,
    tools: {},
    env: {},
  };
}

/** Sets up parseResult mocks for blueprint load + revision history (revision 1) */
function mockBlueprintLoad(blueprint: WorkspaceBlueprint, revision = 1) {
  // Load current blueprint
  mockParseResult.mockResolvedValueOnce(makeArtifactResponse(blueprint, revision));
  // Load revision history (loads revisions from current down to 1, up to 5)
  const maxHistory = Math.min(revision, 5);
  for (let rev = revision; rev > revision - maxHistory && rev >= 1; rev--) {
    mockParseResult.mockResolvedValueOnce(makeArtifactResponse(blueprint, rev));
  }
}

/** Sets up parseResult mock for successful artifact update */
function mockArtifactUpdate(artifactId = "artifact-123", revision = 2) {
  mockParseResult.mockResolvedValueOnce({
    ok: true,
    data: { artifact: { id: artifactId, revision } },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workspaceImproverAgent", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
    mockParseResult.mockReset();
    mockPut.mockReset();
  });

  it("produces a revised artifact on valid input", async () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      workspace: { name: "test-workspace", purpose: "Updated purpose" },
    });

    mockBlueprintLoad(original);
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        revisedBlueprint: revised,
        whatBroke: "Agent description was too vague.",
        whatChanged: "Clarified step description to specify correct tool.",
        changedFields: ["workspace.purpose"],
      },
      usage: { promptTokens: 500, completionTokens: 200 },
    });

    mockArtifactUpdate();

    const result = await handler(defaultInput, makeContext());

    expect(result).toEqual({
      ok: true,
      data: {
        artifactId: "artifact-123",
        revision: 2,
        summary:
          "Agent description was too vague. Clarified step description to specify correct tool.",
        changedFields: ["workspace.purpose"],
      },
    });
  });

  it("stores the revised blueprint with correct payload", async () => {
    const revised = makeBlueprint({
      workspace: { name: "test-workspace", purpose: "Fixed purpose" },
    });

    mockBlueprintLoad(makeBlueprint());
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        revisedBlueprint: revised,
        whatBroke: "Wrong prompt.",
        whatChanged: "Fixed the prompt.",
        changedFields: ["workspace.purpose"],
      },
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    mockArtifactUpdate();

    await handler(defaultInput, makeContext());

    expect(mockPut).toHaveBeenCalledOnce();
    expect(mockPut).toHaveBeenCalledWith({
      param: { id: "artifact-123" },
      json: {
        type: "workspace-plan",
        data: { type: "workspace-plan", version: 2, data: revised },
        summary: "Wrong prompt. Fixed the prompt.",
        revisionMessage: "Wrong prompt. Fixed the prompt.",
      },
    });
  });

  it("retries once when scope validation fails, then succeeds", async () => {
    const original = makeBlueprint();
    const badRevision = makeBlueprint({
      agents: [
        { id: "analyzer", name: "Analyzer", description: "d", capabilities: [] },
        { id: "new-agent", name: "New", description: "Added", capabilities: [] },
      ],
    });
    const goodRevision = makeBlueprint({
      agents: [
        {
          id: "analyzer",
          name: "Analyzer",
          description: "Improved description",
          capabilities: ["analysis"],
        },
      ],
    });

    mockBlueprintLoad(original);
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        revisedBlueprint: badRevision,
        whatBroke: "Bad prompt.",
        whatChanged: "Added helper agent.",
        changedFields: ["agents"],
      },
      usage: { promptTokens: 500, completionTokens: 200 },
    });
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        revisedBlueprint: goodRevision,
        whatBroke: "Bad prompt.",
        whatChanged: "Improved analyzer description.",
        changedFields: ["agents[0].description"],
      },
      usage: { promptTokens: 600, completionTokens: 200 },
    });

    mockArtifactUpdate();

    const result = await handler(defaultInput, makeContext());

    expect(result.ok).toBe(true);
    expect(mockGenerateObject).toHaveBeenCalledTimes(2);

    const retryCall = mockGenerateObject.mock.calls[1]?.[0];
    expect(retryCall).toBeDefined();
    const userMessage = retryCall.messages[1].content;
    expect(userMessage).toContain("REJECTED by the scope guard");
    expect(userMessage).toContain("new-agent");
  });

  it("returns error when scope validation fails after retry", async () => {
    const original = makeBlueprint();
    const badRevision = makeBlueprint({
      agents: [
        { id: "analyzer", name: "Analyzer", description: "d", capabilities: [] },
        { id: "extra", name: "Extra", description: "Nope", capabilities: [] },
      ],
    });

    mockBlueprintLoad(original);
    mockGenerateObject
      .mockResolvedValueOnce({
        object: {
          revisedBlueprint: badRevision,
          whatBroke: "x",
          whatChanged: "y",
          changedFields: [],
        },
        usage: { promptTokens: 500, completionTokens: 200 },
      })
      .mockResolvedValueOnce({
        object: {
          revisedBlueprint: badRevision,
          whatBroke: "x",
          whatChanged: "y",
          changedFields: [],
        },
        usage: { promptTokens: 500, completionTokens: 200 },
      });

    const result = await handler(defaultInput, makeContext());

    if (result.ok) {
      throw new Error("Expected error result but got success");
    }
    expect(result.error).toContain("scope constraints");
  });
});
