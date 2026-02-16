import { describe, expect, it, vi } from "vitest";
import type { Agent, JobWithDAG } from "../types.ts";
import { enrichAgentsWithPipelineContext } from "./enrich-pipeline-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? `Agent ${overrides.id} does things`,
    needs: overrides.needs ?? [],
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

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(agents, jobs, {
      infer,
    });

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
    expect(infer).toHaveBeenCalledWith({ description: "Fetch emails" }, [
      { description: "Summarize emails" },
    ]);
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

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(agents, jobs, {
      infer,
    });

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

    const { agents: enriched, entries } = await enrichAgentsWithPipelineContext(agents, jobs, {
      infer,
    });

    expect(enriched.map((a) => a.description)).toEqual(["Solo agent"]);
    expect(entries).toHaveLength(0);
    expect(infer).not.toHaveBeenCalled();
  });
});
