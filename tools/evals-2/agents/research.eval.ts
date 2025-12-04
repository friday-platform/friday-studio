import { client, parseResult } from "@atlas/client/v2";
import { assert } from "@std/assert";
import { evalite } from "evalite";
import { contains } from "evalite/scorers";
import { webSearchAgent } from "../../../packages/bundled-agents/src/web-search/web-search.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

evalite.each([{ name: "Web Search", input: { agent: webSearchAgent } }])<
  { prompt: string },
  {
    summary: string;
    report: string;
    artifactId: string;
    executionTime: number;
    progressMessages: string[];
  },
  { relevancy: string; entities: string[] }
>("Search agent", {
  data: () => [
    {
      input: {
        prompt:
          "Find recent news from Wrocław, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wrocław city. Include headlines, brief summaries, and source links.",
      },
      expected: {
        relevancy: `The research should:
        1. Focus specifically on Wrocław, Poland
        2. Include recent news (within last 23 hours timeframe)
        3. Cover local news, events, and developments
        4. Provide headlines and brief summaries
        5. Include source links/citations`,
        entities: ["Wrocław"],
      },
    },
    {
      input: {
        prompt:
          "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.",
      },
      expected: {
        relevancy: `The research should:
        1. Provide a list of specific bike makes/models
        2. Explicitly mention wheel size, tire clearance (>2 inches)
        3. Explicitly mention frame material (titanium or carbon)
        4. Include citations with links`,
        entities: ["tire", "titanium", "carbon"],
      },
    },
    {
      input: {
        prompt: `Research the people I'm meeting with today and their companies.
        'Today's Meetings (September 18, 2025):
          "meetings": [
            {
              "title": "Meeting with Parker Conrad @ Rippling",
              "startTime": "2025-09-18T10:00:00 PDT",
              "endTime": "2025-09-18T11:00:00 PDT",
              "duration": "1 hour",
              "isPortfolioCompany": true,
              "portfolioCompany": "Rippling",
              "contactPerson": "Parker Conrad"
            },
            {
              "title": "Meeting with Amjad Masad @ Replit",
              "startTime": "2025-09-18T12:15:00 PDT",
              "endTime": "2025-09-18T13:15:00 PDT",
              "duration": "1 hour",
              "isPortfolioCompany": true,
              "portfolioCompany": "Replit",
              "contactPerson": "Amjad Masad"
            },
            {
              "title": "Meeting with Feross Aboukhadijeh @ Socket",
              "startTime": "2025-09-18T14:15:00 PDT",
              "endTime": "2025-09-18T15:30:00 PDT",
              "duration": "1 hour 15 minutes",
              "isPortfolioCompany": true,
              "portfolioCompany": "Socket",
              "contactPerson": "Feross Aboukhadijeh"
            }
          ]
        '`,
      },
      expected: {
        relevancy: `The research should:
        1. Research Parker Conrad, Amjad Masad, and Feross Aboukhadijeh
        2. Include background and company info for each person
        3. Include citations for facts`,
        entities: [
          "Parker Conrad",
          "Amjad Masad",
          "Feross Aboukhadijeh",
          "Rippling",
          "Replit",
          "Socket",
        ],
      },
    },
  ],
  task: async (input, variant) => {
    const { context, getStreamEvents } = adapter.createContext();
    const startTime = Date.now();
    const result = await variant.agent.execute(input.prompt, context);
    const executionTime = (Date.now() - startTime) / 1000; // Convert to seconds

    // Extract progress messages from stream events (hermetic per test case)
    const progressMessages = getStreamEvents()
      .filter((e) => e.type === "data-tool-progress")
      .map((e) => e.data.content);

    if (!result.ok) {
      throw new Error(`Agent execution failed: ${result.error?.reason}`);
    }

    const { summary, artifactRef } = result.data;
    assert(artifactRef.id, "Missing artifact ID");

    // Fetch artifact to verify it was created and get full report
    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: artifactRef.id } }),
    );
    if (!artifactResponse.ok) {
      throw new Error(`Failed to fetch artifact: ${JSON.stringify(artifactResponse.error)}`);
    }
    assert(artifactResponse.data.artifact.data.type === "summary", "Wrong artifact type");

    const report = artifactResponse.data.artifact.data.data as string;

    return { summary, report, artifactId: artifactRef.id, executionTime, progressMessages };
  },
  scorers: [
    {
      name: "LLMJudge",
      scorer: async ({ output, expected }) => {
        const result = await LLMJudge({
          output: output.report,
          expected: expected.relevancy,
          input: undefined,
        });
        return { ...result, score: result.score ?? 0 };
      },
    },
    {
      scorer: ({ output, expected }) => {
        const entities = expected.entities;
        const presentCount = entities.filter((entity) =>
          output.report.toLowerCase().includes(entity.toLowerCase()),
        ).length;
        const score = presentCount / entities.length;

        return {
          name: "Entity Presence",
          description: `Found ${presentCount}/${entities.length} required entities`,
          score,
          metadata: {
            entities,
            presentCount,
            missing: entities.filter(
              (entity) => !output.report.toLowerCase().includes(entity.toLowerCase()),
            ),
          },
        };
      },
    },
    {
      scorer: ({ output }) => {
        return contains({ actual: output.report, expected: "http" });
      },
    },
  ],
  columns: ({ input, output }) => [
    { label: "Prompt", value: input.prompt.slice(0, 80) + (input.prompt.length > 80 ? "..." : "") },
    { label: "Time", value: `${output.executionTime.toFixed(1)}s` },
    { label: "Progress", value: output.progressMessages },
    { label: "Executive Summary", value: output.summary },
    { label: "Report", value: output.report },
  ],
});

evalite.each([{ name: "Web Search", input: { agent: webSearchAgent } }])<
  { prompt: string },
  { output: string; summary: string; wasFailure: boolean },
  { criteria: string; shouldFail: boolean }
>("Research Agent - Failure Cases", {
  data: () => [
    {
      input: { prompt: "When was Tim Cook appointed the new CEO of OpenAI?" },
      expected: {
        criteria: `The agent should determine that Tim Cook is *not* the CEO of OpenAI. It should correct the false premise and provide accurate information about OpenAI's actual leadership (Sam Altman).`,
        shouldFail: false, // Agent should succeed but correct the misinformation
      },
    },
    {
      input: { prompt: "Who are the people I'm meeting with today and what are their companies?" },
      expected: {
        criteria: `The agent should recognize it cannot complete this task and explain that it doesn't have access to calendar information or knowledge of who the user is meeting with.`,
        shouldFail: true, // Agent should explicitly fail
      },
    },
  ],
  task: async (input, variant) => {
    const { context } = adapter.createContext();
    const result = await variant.agent.execute(input.prompt, context);

    if (result.ok) {
      const { summary, artifactRef } = result.data;

      // Fetch artifact to get full report
      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: artifactRef.id } }),
      );
      assert(artifactResponse.ok, `Failed to fetch artifact`);

      const report = artifactResponse.data.artifact.data.data as string;
      return { output: report, summary, wasFailure: false };
    } else {
      return { output: result.error.reason, summary: "", wasFailure: true };
    }
  },
  scorers: [
    {
      name: "LLMJudge",
      scorer: async ({ output, expected }) => {
        const result = await LLMJudge({
          output: output.output,
          expected: expected.criteria,
          input: undefined,
        });
        return { ...result, score: result.score ?? 0 };
      },
    },
    {
      scorer: ({ output, expected }) => {
        const correctBehavior = output.wasFailure === expected.shouldFail;
        return {
          name: "Failure Behavior",
          description: expected.shouldFail
            ? `Should fail: ${output.wasFailure ? "✓ failed" : "✗ succeeded"}`
            : `Should succeed: ${output.wasFailure ? "✗ failed" : "✓ succeeded"}`,
          score: correctBehavior ? 1 : 0,
          metadata: { wasFailure: output.wasFailure, shouldFail: expected.shouldFail },
        };
      },
    },
  ],
});
