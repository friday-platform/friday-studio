/**
 * Planner agent-splitting eval.
 *
 * Tests that `generatePlan()` correctly collapses or splits agents
 * based on whether operations target the same or different external services.
 *
 * Each case runs in both "task" and "workspace" modes and asserts on
 * agent count and duplicate capabilities detection.
 */

import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
  type PlanMode,
} from "../../../../packages/workspace-builder/planner/plan.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createPlannerEvalPlatformModels } from "../../lib/planner-models.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();
const platformModels = createPlannerEvalPlatformModels();

// ---------------------------------------------------------------------------
// Case type
// ---------------------------------------------------------------------------

interface PlannerCase extends BaseEvalCase {
  expectedAgentCount: number;
  /** Max acceptable agents. Defaults to expectedAgentCount when omitted. */
  maxAgentCount?: number;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: PlannerCase[] = [
  // Collapse: same service = 1 agent
  {
    id: "linear-issue-creation",
    name: "collapse - Linear issue creation",
    input: "Create a Linear issue assigned to me in Tempest team",
    expectedAgentCount: 1,
  },
  {
    id: "slack-search-and-post",
    name: "collapse - Slack search and post",
    input: "Search Slack for outage messages and post summary to #incidents",
    expectedAgentCount: 1,
  },
  {
    id: "calendar-read-and-create",
    name: "collapse - calendar read and create",
    input: "Get my calendar events for today and create a meeting tomorrow",
    expectedAgentCount: 1,
  },

  // Split: different services = separate agents
  // maxAgentCount allows an optional summarizer between services (not ideal but acceptable)
  {
    id: "research-then-email",
    name: "split - research then email",
    input: "Research competitors and email me a summary",
    expectedAgentCount: 2,
    maxAgentCount: 3,
  },
  {
    id: "linear-to-notion",
    name: "split - Linear to Notion",
    input: "Get my Linear tickets and create a Notion page with the summary",
    expectedAgentCount: 2,
    maxAgentCount: 3,
  },
  {
    id: "github-to-slack",
    name: "split - GitHub to Slack",
    input: "Check GitHub PRs and post a digest to Slack",
    expectedAgentCount: 2,
    maxAgentCount: 3,
  },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Detects duplicate `capabilities` arrays across agents.
 * Normalize each agent's capabilities (sort + join), flag any key appearing > 1 time.
 */
function hasDuplicateCapabilities(agents: Array<{ capabilities: string[] }>): boolean {
  const seen = new Set<string>();
  for (const agent of agents) {
    const key = [...agent.capabilities].sort().join(",");
    if (key === "") continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registrations — each case x 2 modes
// ---------------------------------------------------------------------------

const modes: PlanMode[] = ["task", "workspace"];

export const evals: EvalRegistration[] = cases.flatMap((testCase) =>
  modes.map((mode) =>
    defineEval({
      name: `planner/${mode}/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: async () => {
          const result = await generatePlan(testCase.input, { platformModels }, { mode });
          return result;
        },
        assert: (result) => {
          const max = testCase.maxAgentCount ?? testCase.expectedAgentCount;
          const count = result.agents.length;
          if (count < testCase.expectedAgentCount || count > max) {
            const range =
              max > testCase.expectedAgentCount
                ? `${testCase.expectedAgentCount}-${max}`
                : `${testCase.expectedAgentCount}`;
            throw new Error(
              `Expected ${range} agent(s), got ${count}: ` +
                `[${result.agents.map((a) => a.name).join(", ")}]`,
            );
          }
        },
        score: (result) => {
          const max = testCase.maxAgentCount ?? testCase.expectedAgentCount;
          const count = result.agents.length;
          const countInRange = count >= testCase.expectedAgentCount && count <= max;
          const duplicates = hasDuplicateCapabilities(result.agents);
          const range =
            max > testCase.expectedAgentCount
              ? `${testCase.expectedAgentCount}-${max}`
              : `${testCase.expectedAgentCount}`;
          return [
            createScore("agent-count", countInRange ? 1 : 0, `expected ${range}, got ${count}`),
            createScore(
              "no-duplicate-capabilities",
              duplicates ? 0 : 1,
              duplicates
                ? "duplicate capabilities detected across agents"
                : "all agents have distinct capabilities",
            ),
          ];
        },
        metadata: {
          mode,
          expectedAgentCount: testCase.expectedAgentCount,
          promptSnapshot: getSystemPrompt(mode),
          userMessage: formatUserMessage(testCase.input, mode),
        },
      },
    }),
  ),
);
