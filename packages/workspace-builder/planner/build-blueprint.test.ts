import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must come before module imports
// ---------------------------------------------------------------------------

const mockGeneratePlan = vi.hoisted(() => vi.fn());
const mockClassifyAgents = vi.hoisted(() => vi.fn());
const mockEnrichSignals = vi.hoisted(() => vi.fn());
const mockGenerateDAGSteps = vi.hoisted(() => vi.fn());
const mockEnrichAgentsWithPipelineContext = vi.hoisted(() => vi.fn());
const mockGenerateOutputSchemas = vi.hoisted(() => vi.fn());
const mockGeneratePrepareMappings = vi.hoisted(() => vi.fn());
const mockResolveByProvider = vi.hoisted(() => vi.fn());

const MockCredentialNotFoundError = vi.hoisted(
  () =>
    class CredentialNotFoundError extends Error {
      constructor(public readonly provider: string) {
        super(`No credentials found for provider '${provider}'`);
        this.name = "CredentialNotFoundError";
      }
    },
);

vi.mock("./plan.ts", () => ({ generatePlan: mockGeneratePlan }));

vi.mock("./classify-agents.ts", () => ({ classifyAgents: mockClassifyAgents }));

vi.mock("./enrich-signals.ts", () => ({ enrichSignals: mockEnrichSignals }));

vi.mock("./dag.ts", () => ({ generateDAGSteps: mockGenerateDAGSteps }));

vi.mock("./enrich-pipeline-context.ts", () => ({
  enrichAgentsWithPipelineContext: mockEnrichAgentsWithPipelineContext,
}));

vi.mock("./schemas.ts", () => ({ generateOutputSchemas: mockGenerateOutputSchemas }));

vi.mock("./mappings.ts", () => ({ generatePrepareMappings: mockGeneratePrepareMappings }));

vi.mock("@atlas/core/mcp-registry/credential-resolver", () => ({
  resolveCredentialsByProvider: mockResolveByProvider,
  CredentialNotFoundError: MockCredentialNotFoundError,
}));

import type { BuildBlueprintOpts } from "./build-blueprint.ts";
import { buildBlueprint, PipelineError } from "./build-blueprint.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function baseOpts(overrides?: Partial<BuildBlueprintOpts>): BuildBlueprintOpts {
  return { mode: "workspace", logger: mockLogger, ...overrides };
}

const PLAN_RESULT = {
  workspace: { name: "Test Workspace", purpose: "Test" },
  signals: [
    {
      id: "daily-check",
      name: "Daily Check",
      title: "Triggers daily",
      signalType: "schedule" as const,
      description: "Every day at 9am",
    },
  ],
  agents: [
    { id: "researcher", name: "Researcher", description: "Researches things", needs: ["research"] },
    { id: "reporter", name: "Reporter", description: "Reports findings", needs: [] },
  ],
};

const TASK_PLAN_RESULT = {
  workspace: { name: "Task", purpose: "Do a thing" },
  signals: [],
  agents: [
    { id: "analyst", name: "Analyst", description: "Analyzes data", needs: ["data-analysis"] },
  ],
};

const CLASSIFY_RESULT = { agents: PLAN_RESULT.agents, clarifications: [], configRequirements: [] };

const JOBS = [
  {
    id: "main-job",
    name: "Main Job",
    title: "Main",
    triggerSignalId: "daily-check",
    steps: [
      { id: "research", agentId: "researcher", description: "Do research", depends_on: [] },
      { id: "report", agentId: "reporter", description: "Write report", depends_on: ["research"] },
    ],
    documentContracts: [],
    prepareMappings: [],
  },
];

const SCHEMA_MAP = new Map([
  [
    "research",
    { type: "object", properties: { findings: { type: "string" } }, required: ["findings"] },
  ],
  [
    "report",
    { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  ],
]);

const MAPPINGS = [
  {
    consumerStepId: "report",
    documentId: "research-output",
    documentType: "output",
    sources: [{ from: "findings", to: "input" }],
    constants: [],
  },
];

/**
 * Set up all mocks for a successful pipeline run.
 */
function setupSuccessfulPipeline() {
  mockGeneratePlan.mockResolvedValue(PLAN_RESULT);
  mockClassifyAgents.mockResolvedValue(CLASSIFY_RESULT);
  mockEnrichSignals.mockResolvedValue(PLAN_RESULT.signals);
  mockGenerateDAGSteps.mockResolvedValue(JOBS);
  mockEnrichAgentsWithPipelineContext.mockResolvedValue({
    agents: PLAN_RESULT.agents,
    entries: [],
  });
  mockGenerateOutputSchemas.mockResolvedValue(SCHEMA_MAP);
  mockGeneratePrepareMappings.mockResolvedValue(MAPPINGS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildBlueprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("workspace mode", () => {
    it("produces a complete blueprint with workspace, signals, agents, and jobs", async () => {
      setupSuccessfulPipeline();

      const result = await buildBlueprint("Create a research workspace", baseOpts());

      expect(result.blueprint.workspace).toStrictEqual(PLAN_RESULT.workspace);
      expect(result.blueprint.signals).toEqual([
        expect.objectContaining({ id: "daily-check", signalType: "schedule" }),
      ]);
      expect(result.blueprint.agents.map((a) => a.id)).toEqual(["researcher", "reporter"]);
      expect(result.blueprint.jobs).toEqual([
        expect.objectContaining({ id: "main-job", triggerSignalId: "daily-check" }),
      ]);
    });

    it("returns empty clarifications and resolved credentials when no issues", async () => {
      setupSuccessfulPipeline();

      const result = await buildBlueprint("test prompt", baseOpts());

      expect(result.clarifications).toStrictEqual([]);
      expect(result.credentials.bindings).toStrictEqual([]);
      expect(result.credentials.unresolved).toStrictEqual([]);
      expect(result.readiness.ready).toBe(true);
    });
  });

  describe("task mode", () => {
    it("produces empty signals array and uses adhoc trigger", async () => {
      mockGeneratePlan.mockResolvedValue(TASK_PLAN_RESULT);
      mockClassifyAgents.mockResolvedValue({
        agents: TASK_PLAN_RESULT.agents,
        clarifications: [],
        configRequirements: [],
      });
      mockGenerateDAGSteps.mockResolvedValue([
        {
          id: "task-job",
          name: "Task",
          title: "Task",
          triggerSignalId: "adhoc-trigger",
          steps: [{ id: "analyze", agentId: "analyst", description: "Analyze", depends_on: [] }],
          documentContracts: [],
          prepareMappings: [],
        },
      ]);
      mockEnrichAgentsWithPipelineContext.mockResolvedValue({
        agents: TASK_PLAN_RESULT.agents,
        entries: [],
      });
      mockGenerateOutputSchemas.mockResolvedValue(
        new Map([["analyze", { type: "object", properties: {} }]]),
      );
      mockGeneratePrepareMappings.mockResolvedValue([]);

      const result = await buildBlueprint("Analyze this data", baseOpts({ mode: "task" }));

      expect(result.blueprint.signals).toStrictEqual([]);
      expect(result.blueprint.jobs).toEqual([
        expect.objectContaining({ triggerSignalId: "adhoc-trigger" }),
      ]);
    });
  });

  describe("PipelineError", () => {
    it("thrown on step failure with correct phase and cause", async () => {
      const cause = new Error("LLM call failed");
      mockGeneratePlan.mockRejectedValue(cause);

      await expect(buildBlueprint("test", baseOpts())).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PipelineError)) return false;
        return (
          err.phase === "plan" && err.cause === cause && err.message.includes("LLM call failed")
        );
      });
    });

    it("preserves phase from the failing step", async () => {
      setupSuccessfulPipeline();
      mockGenerateDAGSteps.mockRejectedValue(new Error("Cycle detected"));

      await expect(buildBlueprint("test", baseOpts())).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PipelineError)) return false;
        return err.phase === "dag";
      });
    });

    it("does not wrap PipelineError in another PipelineError", async () => {
      setupSuccessfulPipeline();
      const original = new PipelineError("inner", new Error("inner cause"));
      mockGenerateDAGSteps.mockRejectedValue(original);

      await expect(buildBlueprint("test", baseOpts())).rejects.toBe(original);
    });
  });

  describe("soft issues", () => {
    it("returns clarifications in result when classification is ambiguous", async () => {
      setupSuccessfulPipeline();
      mockClassifyAgents.mockResolvedValue({
        agents: PLAN_RESULT.agents,
        clarifications: [
          {
            agentId: "researcher",
            agentName: "Researcher",
            need: "obscure-tool",
            issue: { type: "no-match" },
          },
        ],
        configRequirements: [],
      });

      const result = await buildBlueprint("test", baseOpts());

      expect(result.clarifications).toHaveLength(1);
      expect(result.clarifications[0]).toStrictEqual({
        agentId: "researcher",
        agentName: "Researcher",
        need: "obscure-tool",
        issue: { type: "no-match" },
      });
    });

    it("returns unresolved credentials when credentials cannot be resolved", async () => {
      setupSuccessfulPipeline();
      mockClassifyAgents.mockResolvedValue({
        agents: PLAN_RESULT.agents,
        clarifications: [],
        configRequirements: [
          {
            agentId: "researcher",
            agentName: "Researcher",
            integration: { type: "mcp", serverId: "github" },
            requiredConfig: [
              {
                key: "GITHUB_TOKEN",
                description: "GitHub token",
                provider: "github",
                source: "link",
              },
            ],
          },
        ],
      });
      // Real resolveCredentials runs — mock the underlying Link API call
      mockResolveByProvider.mockRejectedValueOnce(new MockCredentialNotFoundError("github"));

      const result = await buildBlueprint("test", baseOpts());

      expect(result.credentials.unresolved).toHaveLength(1);
      expect(result.credentials.unresolved[0]).toEqual(
        expect.objectContaining({
          agentId: "researcher",
          field: "GITHUB_TOKEN",
          provider: "github",
          reason: expect.stringContaining("github"),
        }),
      );
      expect(result.readiness.ready).toBe(false);
    });

    it("tracks credential ambiguity as unresolved", async () => {
      setupSuccessfulPipeline();
      mockClassifyAgents.mockResolvedValue({
        agents: PLAN_RESULT.agents,
        clarifications: [],
        configRequirements: [
          {
            agentId: "researcher",
            agentName: "Researcher",
            integration: { type: "mcp", serverId: "google-gmail" },
            requiredConfig: [
              {
                key: "GOOGLE_TOKEN",
                description: "Google OAuth token",
                provider: "google",
                source: "link",
              },
            ],
          },
        ],
      });
      // Real resolveCredentials runs — mock the underlying Link API call
      mockResolveByProvider.mockRejectedValueOnce(new MockCredentialNotFoundError("google"));

      const result = await buildBlueprint("test", baseOpts());

      expect(result.credentials.unresolved).toEqual([
        expect.objectContaining({ provider: "google", reason: expect.stringContaining("google") }),
      ]);
    });
  });

  describe("AbortSignal", () => {
    it("throws AbortError when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        buildBlueprint("test", baseOpts({ abortSignal: controller.signal })),
      ).rejects.toThrow();
    });

    it("propagates AbortError without wrapping in PipelineError", async () => {
      const abortError = new DOMException("The operation was aborted.", "AbortError");
      mockGeneratePlan.mockRejectedValue(abortError);

      await expect(buildBlueprint("test", baseOpts())).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === "AbortError";
      });
    });

    it("cancels mid-pipeline — subsequent steps do not run", async () => {
      const controller = new AbortController();

      mockGeneratePlan.mockResolvedValue(PLAN_RESULT);
      mockClassifyAgents.mockResolvedValue(CLASSIFY_RESULT);
      mockEnrichSignals.mockResolvedValue(PLAN_RESULT.signals);
      mockGenerateDAGSteps.mockImplementation(() => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      });

      await expect(
        buildBlueprint("test", baseOpts({ abortSignal: controller.signal })),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof DOMException && err.name === "AbortError",
      );
    });
  });

  describe("contract completeness gate", () => {
    it("retries missing schemas once", async () => {
      setupSuccessfulPipeline();

      const incompleteSchemas = new Map([
        ["research", { type: "object", properties: { findings: { type: "string" } } }],
      ]);
      const retrySchemas = new Map([
        ["report", { type: "object", properties: { summary: { type: "string" } } }],
      ]);

      mockGenerateOutputSchemas
        .mockResolvedValueOnce(incompleteSchemas)
        .mockResolvedValueOnce(retrySchemas);

      const result = await buildBlueprint("test", baseOpts());

      expect(result.blueprint.jobs).toHaveLength(1);
      const job = result.blueprint.jobs[0];
      expect.assert(job !== undefined);
      expect(job.documentContracts).toHaveLength(2);
    });

    it("throws PipelineError when retry also fails", async () => {
      setupSuccessfulPipeline();

      const incompleteSchemas = new Map([["research", { type: "object", properties: {} }]]);

      mockGenerateOutputSchemas
        .mockResolvedValueOnce(incompleteSchemas)
        .mockResolvedValueOnce(new Map());

      await expect(buildBlueprint("test", baseOpts())).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PipelineError)) return false;
        return err.phase === "contract-completeness" && err.cause.message.includes("report");
      });
    });

    it("skips retry when all schemas are present", async () => {
      setupSuccessfulPipeline();

      const result = await buildBlueprint("test", baseOpts());

      expect(mockGenerateOutputSchemas).toHaveBeenCalledTimes(1);
      expect(result.blueprint.jobs).toHaveLength(1);
      const job = result.blueprint.jobs[0];
      expect.assert(job !== undefined);
      expect(job.documentContracts).toHaveLength(2);
    });
  });

  describe("bundled agent schema lookup", () => {
    it("passes post-stamp steps and agents with bundledId to generateOutputSchemas", async () => {
      // Post-classify: agent keeps planner ID "csv-data-analyst" but gets bundledId "data-analyst"
      const bundledAgents = [
        {
          id: "csv-data-analyst",
          name: "CSV Data Analyst",
          description: "Analyzes CSV data",
          needs: ["data-analysis"],
          bundledId: "data-analyst",
        },
        { id: "reporter", name: "Reporter", description: "Reports findings", needs: [] },
      ];

      // Post-stamp: steps use bundled IDs (stampExecutionTypes rewrites agentId)
      const stamped = [
        {
          id: "stamp-job",
          name: "Job",
          title: "Job",
          triggerSignalId: "daily-check",
          steps: [
            {
              id: "analyze",
              agentId: "data-analyst",
              description: "Analyze",
              depends_on: [],
              executionType: "bundled",
            },
            {
              id: "report",
              agentId: "reporter",
              description: "Report",
              depends_on: ["analyze"],
              executionType: "llm",
              tools: [],
            },
          ],
          documentContracts: [],
          prepareMappings: [],
        },
      ];

      mockGeneratePlan.mockResolvedValue({
        workspace: { name: "Test", purpose: "Test" },
        signals: PLAN_RESULT.signals,
        agents: bundledAgents,
      });
      mockClassifyAgents.mockResolvedValue({
        agents: bundledAgents,
        clarifications: [],
        configRequirements: [],
      });
      mockEnrichSignals.mockResolvedValue(PLAN_RESULT.signals);
      mockGenerateDAGSteps.mockResolvedValue(stamped);
      mockEnrichAgentsWithPipelineContext.mockResolvedValue({ agents: bundledAgents, entries: [] });
      // generateOutputSchemas is mocked — verify it receives post-stamp steps + original agents
      mockGenerateOutputSchemas.mockResolvedValue(
        new Map([
          ["analyze", { type: "object", properties: { result: { type: "string" } } }],
          ["report", { type: "object", properties: { summary: { type: "string" } } }],
        ]),
      );
      mockGeneratePrepareMappings.mockResolvedValue([]);

      const result = await buildBlueprint("Analyze CSV", baseOpts());

      // generateOutputSchemas received post-stamp steps (agentId: "data-analyst")
      // alongside agents keyed by planner ID ("csv-data-analyst")
      expect(mockGenerateOutputSchemas).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ agentId: "data-analyst" })]),
        expect.arrayContaining([
          expect.objectContaining({ id: "csv-data-analyst", bundledId: "data-analyst" }),
        ]),
      );
      expect(result.blueprint.jobs).toHaveLength(1);
      const job = result.blueprint.jobs[0];
      expect.assert(job !== undefined);
      // Returned schemas land in documentContracts
      expect(job.documentContracts).toHaveLength(2);
      expect(job.documentContracts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            producerStepId: "analyze",
            schema: { type: "object", properties: { result: { type: "string" } } },
          }),
          expect.objectContaining({
            producerStepId: "report",
            schema: { type: "object", properties: { summary: { type: "string" } } },
          }),
        ]),
      );
    });
  });

  describe("precomputed option", () => {
    it("skips generatePlan and classifyAgents when precomputed is provided", async () => {
      // Set up mocks for steps after plan+classify
      mockEnrichSignals.mockResolvedValue(PLAN_RESULT.signals);
      mockGenerateDAGSteps.mockResolvedValue(JOBS);
      mockEnrichAgentsWithPipelineContext.mockResolvedValue({
        agents: PLAN_RESULT.agents,
        entries: [],
      });
      mockGenerateOutputSchemas.mockResolvedValue(SCHEMA_MAP);
      mockGeneratePrepareMappings.mockResolvedValue(MAPPINGS);

      const result = await buildBlueprint(
        "test",
        baseOpts({
          precomputed: {
            plan: PLAN_RESULT,
            classified: { clarifications: [], configRequirements: [] },
          },
        }),
      );

      expect(mockGeneratePlan).not.toHaveBeenCalled();
      expect(mockClassifyAgents).not.toHaveBeenCalled();
      expect(result.blueprint.workspace).toStrictEqual(PLAN_RESULT.workspace);
      expect(result.blueprint.agents.map((a) => a.id)).toEqual(["researcher", "reporter"]);
    });

    it("uses precomputed clarifications and configRequirements", async () => {
      mockEnrichSignals.mockResolvedValue(PLAN_RESULT.signals);
      mockGenerateDAGSteps.mockResolvedValue(JOBS);
      mockEnrichAgentsWithPipelineContext.mockResolvedValue({
        agents: PLAN_RESULT.agents,
        entries: [],
      });
      mockGenerateOutputSchemas.mockResolvedValue(SCHEMA_MAP);
      mockGeneratePrepareMappings.mockResolvedValue(MAPPINGS);

      const precomputedClarifications = [
        {
          agentId: "researcher",
          agentName: "Researcher",
          need: "obscure-tool",
          issue: { type: "no-match" as const },
        },
      ];

      const result = await buildBlueprint(
        "test",
        baseOpts({
          precomputed: {
            plan: PLAN_RESULT,
            classified: { clarifications: precomputedClarifications, configRequirements: [] },
          },
        }),
      );

      expect(result.clarifications).toStrictEqual(precomputedClarifications);
    });
  });
});
