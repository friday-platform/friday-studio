import { createStubPlatformModels } from "@atlas/llm";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import { describe, expect, it, vi } from "vitest";
import type { Agent, JobWithDAG } from "../types.ts";
import { enrichAgentsWithPipelineContext } from "./enrich-pipeline-context.ts";

const platformModels = createStubPlatformModels();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? `Agent ${overrides.id} does things`,
    capabilities: overrides.capabilities ?? [],
  };
}

function makeJob(
  overrides: Partial<JobWithDAG> & { id: string; steps: JobWithDAG["steps"] },
): JobWithDAG {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Job",
    title: overrides.title ?? "Test",
    triggerSignalId: overrides.triggerSignalId ?? "test-signal",
    steps: overrides.steps,
    documentContracts: overrides.documentContracts ?? [],
    prepareMappings: overrides.prepareMappings ?? [],
  };
}

// ---------------------------------------------------------------------------
// enrichAgentsWithPipelineContext
// ---------------------------------------------------------------------------

describe("enrichAgentsWithPipelineContext", () => {
  it("enriches upstream agents and leaves terminal agents unchanged", async () => {
    const infer = vi
      .fn()
      .mockResolvedValue(
        "Include full message bodies and sender details, not just headers or metadata.",
      );
    const agents = [
      makeAgent({ id: "fetcher", description: "Fetches emails" }),
      makeAgent({ id: "summarizer", description: "Summarizes content" }),
    ];
    const jobs = [
      makeJob({
        id: "email-job",
        steps: [
          { id: "step-0", agentId: "fetcher", description: "Fetch emails", depends_on: [] },
          {
            id: "step-1",
            agentId: "summarizer",
            description: "Summarize emails",
            depends_on: ["step-0"],
          },
        ],
      }),
    ];

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer },
    );

    const enrichedDescription =
      "Fetches emails\n\nDOWNSTREAM DATA REQUIREMENTS:\nInclude full message bodies and sender details, not just headers or metadata.";

    // Upstream agent enriched, terminal agent untouched
    expect(enriched.map((a) => a.description)).toEqual([enrichedDescription, "Summarizes content"]);
    expect(entries).toEqual([
      {
        agentId: "fetcher",
        originalDescription: "Fetches emails",
        enrichedDescription,
        downstreamSteps: ["step-1"],
      },
    ]);
    expect(infer).toHaveBeenCalledOnce();
    expect(infer).toHaveBeenCalledWith(
      { description: "Fetch emails" },
      [{ description: "Summarize emails" }],
      platformModels,
    );
  });

  it("accumulates requirements for agent appearing in multiple jobs", async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce("Include complete records with all relevant attributes from source A.")
      .mockResolvedValueOnce("Capture full data payloads from source B, not just summaries.");

    const agents = [
      makeAgent({ id: "fetcher", description: "Fetches data" }),
      makeAgent({ id: "analyzer", description: "Analyzes data" }),
      makeAgent({ id: "reporter", description: "Generates reports" }),
    ];
    const jobs = [
      makeJob({
        id: "job-a",
        steps: [
          { id: "step-0", agentId: "fetcher", description: "Fetch from source A", depends_on: [] },
          {
            id: "step-1",
            agentId: "analyzer",
            description: "Analyze source A",
            depends_on: ["step-0"],
          },
        ],
      }),
      makeJob({
        id: "job-b",
        steps: [
          { id: "step-0", agentId: "fetcher", description: "Fetch from source B", depends_on: [] },
          {
            id: "step-1",
            agentId: "reporter",
            description: "Report on source B",
            depends_on: ["step-0"],
          },
        ],
      }),
    ];

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer },
    );

    const enrichedDescription =
      "Fetches data\n\nDOWNSTREAM DATA REQUIREMENTS:\nInclude complete records with all relevant attributes from source A.\n\nCapture full data payloads from source B, not just summaries.";

    // Fetcher accumulated from both jobs; analyzer and reporter are terminal
    expect(enriched.map((a) => a.description)).toEqual([
      enrichedDescription,
      "Analyzes data",
      "Generates reports",
    ]);
    expect(entries).toEqual([
      {
        agentId: "fetcher",
        originalDescription: "Fetches data",
        enrichedDescription,
        downstreamSteps: ["step-1", "step-1"],
      },
    ]);
    expect(infer).toHaveBeenCalledTimes(2);
  });

  it("returns empty entries when all steps are terminal", async () => {
    const infer = vi.fn();
    const agents = [makeAgent({ id: "solo", description: "Solo agent" })];
    const jobs = [
      makeJob({
        id: "solo-job",
        steps: [{ id: "step-0", agentId: "solo", description: "Do the thing", depends_on: [] }],
      }),
    ];

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer },
    );

    expect(enriched.map((a) => a.description)).toEqual(["Solo agent"]);
    expect(entries).toHaveLength(0);
    expect(infer).not.toHaveBeenCalled();
  });

  it("enriches bundled agent when step.agentId matches planner ID (not bundled ID)", async () => {
    const infer = vi
      .fn()
      .mockResolvedValue("Include full CSV row data with headers, not just row counts.");

    // Agent has planner ID "csv-data-analyst" with bundledId "data-analyst"
    const agents = [
      makeAgent({
        id: "csv-data-analyst",
        description: "Analyzes CSV files",
        capabilities: ["data-analysis"],
      }),
      makeAgent({ id: "reporter", description: "Reports findings" }),
    ];

    // Post-stamp: step.agentId is the planner ID (preserved by stampExecutionTypes)
    const jobs = [
      makeJob({
        id: "csv-job",
        steps: [
          {
            id: "analyze",
            agentId: "csv-data-analyst",
            description: "Analyze CSV data",
            depends_on: [],
          },
          {
            id: "report",
            agentId: "reporter",
            description: "Generate report",
            depends_on: ["analyze"],
          },
        ],
      }),
    ];

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer },
    );

    // Bundled agent receives enrichment because step.agentId matches agent.id
    expect(enriched[0]?.description).toBe(
      "Analyzes CSV files\n\nDOWNSTREAM DATA REQUIREMENTS:\nInclude full CSV row data with headers, not just row counts.",
    );
    expect(entries).toEqual([
      {
        agentId: "csv-data-analyst",
        originalDescription: "Analyzes CSV files",
        enrichedDescription: enriched[0]?.description,
        downstreamSteps: ["report"],
      },
    ]);
    expect(infer).toHaveBeenCalledOnce();
  });
});

describe("enrichAgentsWithPipelineContext — resource enrichment", () => {
  const DOCUMENT_RESOURCE: ResourceDeclaration = {
    type: "document",
    slug: "grocery_list",
    name: "Grocery List",
    description: "Items to buy at the store",
    schema: {
      type: "object" as const,
      properties: { item: { type: "string" as const }, quantity: { type: "integer" as const } },
      required: ["item"],
    },
  };

  const EXTERNAL_REF: ResourceDeclaration = {
    type: "external_ref",
    slug: "budget_sheet",
    name: "Budget Sheet",
    description: "External Google Sheet for budget tracking",
    provider: "google-sheets",
  };

  it("appends document resource guidance to all agents", async () => {
    const infer = vi.fn();
    const agents = [
      makeAgent({ id: "planner", description: "Plans meals" }),
      makeAgent({ id: "shopper", description: "Creates shopping lists" }),
    ];
    const jobs = [
      makeJob({
        id: "job",
        steps: [{ id: "step-0", agentId: "planner", description: "Plan meals", depends_on: [] }],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer, resources: [DOCUMENT_RESOURCE] },
    );

    for (const agent of enriched) {
      expect(agent.description).toContain("## Workspace Resources");
      expect(agent.description).toContain("grocery_list");
      expect(agent.description).toContain("resource_read");
      expect(agent.description).toContain("resource_write");
    }
  });

  it("appends external ref guidance with provider name", async () => {
    const infer = vi.fn();
    const agents = [makeAgent({ id: "syncer", description: "Syncs data" })];
    const jobs = [
      makeJob({
        id: "job",
        steps: [{ id: "step-0", agentId: "syncer", description: "Sync data", depends_on: [] }],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer, resources: [EXTERNAL_REF] },
    );

    expect(enriched[0]?.description).toContain("## Workspace Resources");
    expect(enriched[0]?.description).toContain("budget_sheet");
    expect(enriched[0]?.description).toContain("google-sheets");
  });

  it("combines document and external ref resources", async () => {
    const infer = vi.fn();
    const agents = [makeAgent({ id: "agent", description: "Does things" })];
    const jobs = [
      makeJob({
        id: "job",
        steps: [{ id: "step-0", agentId: "agent", description: "Do things", depends_on: [] }],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer, resources: [DOCUMENT_RESOURCE, EXTERNAL_REF] },
    );

    const desc = enriched[0]?.description ?? "";
    expect(desc).toContain("grocery_list");
    expect(desc).toContain("budget_sheet");
  });

  it("does not add resource section when resources array is empty", async () => {
    const infer = vi.fn();
    const agents = [makeAgent({ id: "agent", description: "Does things" })];
    const jobs = [
      makeJob({
        id: "job",
        steps: [{ id: "step-0", agentId: "agent", description: "Do things", depends_on: [] }],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer, resources: [] },
    );

    expect(enriched[0]?.description).not.toContain("## Workspace Resources");
  });

  it("does not add resource section when resources not provided", async () => {
    const infer = vi.fn();
    const agents = [makeAgent({ id: "agent", description: "Does things" })];
    const jobs = [
      makeJob({
        id: "job",
        steps: [{ id: "step-0", agentId: "agent", description: "Do things", depends_on: [] }],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer },
    );

    expect(enriched[0]?.description).not.toContain("## Workspace Resources");
  });

  it("works alongside downstream data requirements", async () => {
    const infer = vi.fn().mockResolvedValue("Include full recipe details, not just titles.");
    const agents = [
      makeAgent({ id: "fetcher", description: "Fetches recipes" }),
      makeAgent({ id: "saver", description: "Saves to grocery list" }),
    ];
    const jobs = [
      makeJob({
        id: "job",
        steps: [
          { id: "step-0", agentId: "fetcher", description: "Fetch recipes", depends_on: [] },
          {
            id: "step-1",
            agentId: "saver",
            description: "Save grocery items",
            depends_on: ["step-0"],
          },
        ],
      }),
    ];

    const { agents: enriched } = await enrichAgentsWithPipelineContext(
      agents,
      jobs,
      { platformModels },
      { infer, resources: [DOCUMENT_RESOURCE] },
    );

    const fetcherDesc = enriched[0]?.description ?? "";
    // Has both downstream requirements AND resource section
    expect(fetcherDesc).toContain("DOWNSTREAM DATA REQUIREMENTS:");
    expect(fetcherDesc).toContain("## Workspace Resources");
    expect(fetcherDesc).toContain("grocery_list");
  });
});
