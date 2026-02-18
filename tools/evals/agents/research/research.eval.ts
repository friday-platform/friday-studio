/**
 * Web Search (Research) Agent eval.
 *
 * Two suites:
 * 1. Search Agent — verifies the agent produces a relevant report with
 *    citations and expected entities.
 * 2. Failure Cases — verifies the agent handles misinformation and
 *    impossible requests correctly.
 */

import { webSearchAgent } from "@atlas/bundled-agents";
import { client, parseResult } from "@atlas/client/v2";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Suite 1: Search Agent — positive cases
// ---------------------------------------------------------------------------

interface SearchCase extends BaseEvalCase {
  relevancy: string;
  entities: string[];
}

const searchCases: SearchCase[] = [
  {
    id: "wroclaw-local-news",
    name: "search - Wroclaw local news",
    input:
      "Find recent news from Wrocław, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wrocław city. Include headlines, brief summaries, and source links.",
    relevancy: `The research should:
1. Focus specifically on Wrocław, Poland
2. Include recent news (within last 23 hours timeframe)
3. Cover local news, events, and developments
4. Provide headlines and brief summaries
5. Include source links/citations`,
    entities: ["Wrocław"],
  },
  {
    id: "gravel-bikes-tire-clearance",
    name: "search - gravel bikes tire clearance",
    input:
      "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.",
    relevancy: `The research should:
1. Provide a list of specific bike makes/models
2. Explicitly mention wheel size, tire clearance (>2 inches)
3. Explicitly mention frame material (titanium or carbon)
4. Include citations with links`,
    entities: ["tire", "titanium", "carbon"],
  },
  {
    id: "meeting-contacts-portfolio",
    name: "search - meeting contacts portfolio",
    input: `Research the people I'm meeting with today and their companies.
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
];

const searchEvals = searchCases.map((testCase) =>
  defineEval({
    name: `research/search/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (prompt, context) => {
        const result = await webSearchAgent.execute(prompt, context);
        if (!result.ok) {
          throw new Error(`Agent execution failed: ${result.error?.reason}`);
        }

        const { response: summary } = result.data;
        const artifactRef = result.artifactRefs?.[0];
        assert(artifactRef?.id, "Missing artifact ID");

        const artifactResponse = await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: artifactRef.id } }),
        );
        if (!artifactResponse.ok) {
          throw new Error(`Failed to fetch artifact: ${JSON.stringify(artifactResponse.error)}`);
        }
        assert(artifactResponse.data.artifact.data.type === "summary", "Wrong artifact type");

        const report = artifactResponse.data.artifact.data.data as string;
        return { summary, report, artifactId: artifactRef.id };
      },
      assert: (result) => {
        assert(result.report.length > 0, "Report should not be empty");
      },
      score: async (result) => {
        const judge = await llmJudge(result.report, testCase.relevancy);

        // Entity presence scorer
        const presentCount = testCase.entities.filter((entity) =>
          result.report.toLowerCase().includes(entity.toLowerCase()),
        ).length;
        const entityValue = presentCount / testCase.entities.length;
        const entityScore = createScore(
          "EntityPresence",
          entityValue,
          `Found ${presentCount}/${testCase.entities.length} entities`,
        );

        // Citation presence
        const hasCitations = result.report.includes("http");
        const citationScore = createScore("HasCitations", hasCitations ? 1 : 0);

        return [judge, entityScore, citationScore];
      },
      metadata: { entities: testCase.entities },
    },
  }),
);

// ---------------------------------------------------------------------------
// Suite 2: Failure Cases
// ---------------------------------------------------------------------------

interface FailureCase extends BaseEvalCase {
  criteria: string;
  shouldFail: boolean;
}

const failureCases: FailureCase[] = [
  {
    id: "false-premise-ceo",
    name: "failure - false premise CEO",
    input: "When was Tim Cook appointed the new CEO of OpenAI?",
    criteria: `The agent should determine that Tim Cook is *not* the CEO of OpenAI. It should correct the false premise and provide accurate information about OpenAI's actual leadership (Sam Altman).`,
    shouldFail: false,
  },
  {
    id: "no-calendar-access",
    name: "failure - no calendar access",
    input: "Who are the people I'm meeting with today and what are their companies?",
    criteria: `The agent should recognize it cannot complete this task and explain that it doesn't have access to calendar information or knowledge of who the user is meeting with.`,
    shouldFail: true,
  },
];

const failureEvals = failureCases.map((testCase) =>
  defineEval({
    name: `research/failure/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (prompt, context) => {
        const result = await webSearchAgent.execute(prompt, context);

        if (result.ok) {
          const { response: summary } = result.data;
          const artifactRef = result.artifactRefs?.[0];
          if (!artifactRef) throw new Error("Missing artifact reference");

          const artifactResponse = await parseResult(
            client.artifactsStorage[":id"].$get({ param: { id: artifactRef.id } }),
          );
          assert(artifactResponse.ok, "Failed to fetch artifact");

          const report = artifactResponse.data.artifact.data.data as string;
          return { output: report, summary, wasFailure: false };
        }
        return { output: result.error.reason, summary: "", wasFailure: true };
      },
      score: async (result) => {
        const judge = await llmJudge(result.output, testCase.criteria);

        const correctBehavior = result.wasFailure === testCase.shouldFail;
        const behaviorScore = createScore(
          "FailureBehavior",
          correctBehavior ? 1 : 0,
          testCase.shouldFail
            ? `Should fail: ${result.wasFailure ? "failed" : "succeeded"}`
            : `Should succeed: ${result.wasFailure ? "failed" : "succeeded"}`,
        );

        return [judge, behaviorScore];
      },
      metadata: { shouldFail: testCase.shouldFail },
    },
  }),
);

export const evals: EvalRegistration[] = [...searchEvals, ...failureEvals];
