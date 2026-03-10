/**
 * Planner routing eval — capability selection correctness.
 *
 * Tests that `generatePlan()` selects the right capability IDs
 * for various user prompts. Each case defines expected capabilities
 * and scores binary per agent (correct/incorrect routing).
 *
 * Runs each case in both "task" and "workspace" modes.
 */

import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
  type PlanMode,
} from "../../../../packages/workspace-builder/planner/plan.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Case type
// ---------------------------------------------------------------------------

/**
 * Per-agent capability rule for multi-agent scenarios where different agents
 * in the same plan need different routing (e.g., URL fetcher vs web searcher).
 */
interface AgentCapabilityRule {
  /** Regex to match against agent name in the generated plan. */
  namePattern: RegExp;
  /** Capabilities this matched agent MUST have. */
  expected?: string[];
  /** Capabilities this matched agent must NOT have. */
  forbidden?: string[];
}

interface RoutingCase extends BaseEvalCase {
  /**
   * Expected capability IDs that should appear across ALL agents in the plan.
   * Empty array means all agents should use `capabilities: []` (built-in only).
   */
  expectedCapabilities: string[];
  /**
   * Capability IDs that must NOT appear in any agent's capabilities.
   * Used for disambiguation cases (e.g., "slack" not "email").
   */
  forbiddenCapabilities?: string[];
  /**
   * Per-agent rules for multi-agent plans where different agents need
   * different capabilities. Scored independently per matched agent.
   */
  agentRules?: AgentCapabilityRule[];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: RoutingCase[] = [
  // -------------------------------------------------------------------------
  // "None" cases — built-in tools sufficient, no external capabilities needed
  // -------------------------------------------------------------------------
  {
    id: "grocery-list-crud",
    name: "none - grocery list CRUD",
    input:
      "Create a workspace that manages a grocery list. Users can add items, remove items, and mark items as bought.",
    expectedCapabilities: [],
  },
  {
    id: "task-tracker",
    name: "none - task tracker",
    input:
      "Build a task tracker. Users create tasks with status (todo, in-progress, done) and can update status.",
    expectedCapabilities: [],
  },
  {
    id: "data-transformation",
    name: "none - data transformation between steps",
    input:
      "Transform incoming webhook data: extract the relevant fields, reformat as a summary, and store in a resource table.",
    expectedCapabilities: [],
  },

  // -------------------------------------------------------------------------
  // Bundled agent cases
  // -------------------------------------------------------------------------
  {
    id: "analyze-csv",
    name: "bundled - analyze sales CSV",
    input: "Analyze this uploaded sales CSV and produce a revenue trends report with charts.",
    expectedCapabilities: ["data-analyst"],
  },
  {
    id: "post-to-slack",
    name: "bundled - post to Slack",
    input: "Post a daily standup summary to the #engineering Slack channel.",
    expectedCapabilities: ["slack"],
  },
  {
    id: "send-email",
    name: "bundled - send summary email",
    input: "Send a weekly summary email to team@company.com with project updates.",
    expectedCapabilities: ["email"],
    forbiddenCapabilities: ["google-gmail"],
  },
  {
    id: "transcribe-audio",
    name: "bundled - transcribe audio file",
    input: "Transcribe this audio file",
    expectedCapabilities: ["transcribe"],
  },
  {
    id: "voice-memo-to-text",
    name: "bundled - voice memo to text",
    input: "What does this voice memo say?",
    expectedCapabilities: ["transcribe"],
  },
  {
    id: "transcribe-and-summarize",
    name: "bundled - transcribe and summarize",
    input: "Transcribe this recording and summarize the key points",
    expectedCapabilities: ["transcribe"],
  },
  {
    id: "convert-recording-to-text",
    name: "bundled - convert recording to text",
    input: "Convert this recording to text",
    expectedCapabilities: ["transcribe"],
  },

  // -------------------------------------------------------------------------
  // MCP server cases
  // -------------------------------------------------------------------------
  {
    id: "read-gmail",
    name: "mcp - read Gmail inbox",
    input: "Read my Gmail inbox, find emails from investors this week, and summarize them.",
    expectedCapabilities: ["google-gmail"],
    forbiddenCapabilities: ["email"],
  },
  {
    id: "update-google-sheet",
    name: "mcp - update Google Sheet",
    input: "Update the Q1 revenue Google Sheet with this month's numbers.",
    expectedCapabilities: ["google-sheets"],
  },
  {
    id: "create-github-issue",
    name: "mcp - create GitHub issue",
    input: "Create a GitHub issue in the acme/webapp repo for the login bug.",
    expectedCapabilities: ["github"],
  },

  // -------------------------------------------------------------------------
  // Disambiguation cases
  // -------------------------------------------------------------------------
  {
    id: "slack-not-email",
    name: "disambig - Slack notification not email",
    input: "Send a Slack notification to #alerts when the cron job completes.",
    expectedCapabilities: ["slack"],
    forbiddenCapabilities: ["email", "google-gmail"],
  },
  {
    id: "fathom-not-calendar",
    name: "disambig - Fathom meeting transcript not calendar",
    input: "Get my latest Fathom meeting recording and transcript.",
    expectedCapabilities: ["fathom-get-transcript"],
    forbiddenCapabilities: ["google-calendar"],
  },

  // -------------------------------------------------------------------------
  // URL fetching vs web search — webfetch built-in is sufficient
  // -------------------------------------------------------------------------
  {
    id: "scrape-url-for-content",
    name: "none - scrape specific URL for content extraction",
    input:
      "Build a workspace with an agent that uses webfetch to load the page at bucketlistrewards.com and parse out brand terms, product names, and key identifiers from the HTML.",
    expectedCapabilities: [],
    forbiddenCapabilities: ["research"],
  },
  {
    id: "verify-links",
    name: "none - verify URLs by fetching them",
    input:
      "Build a workspace with an agent that takes a list of known URLs and fetches each one to check it returns HTTP 200. Follow redirects and drop any URL that returns a 404.",
    expectedCapabilities: [],
    forbiddenCapabilities: ["research"],
  },

  // -------------------------------------------------------------------------
  // Multi-agent — per-agent routing (some agents need research, others don't)
  // -------------------------------------------------------------------------
  {
    id: "brand-monitor-pipeline",
    name: "multi-agent - brand monitor with URL fetching and web search",
    input:
      "Build a brand mention monitor for bucketlistrewards.com. " +
      "First agent: fetch bucketlistrewards.com to extract brand terms and product names. " +
      "Second agent: search the web for mentions of those brand terms across news and blogs. " +
      "Third agent: verify each found URL by fetching it to confirm it resolves. " +
      "Fourth agent: compile verified results into a digest email.",
    expectedCapabilities: ["research"],
    agentRules: [
      { namePattern: /brand.*(term|extract)|extract.*brand|fetch.*site/i, forbidden: ["research"] },
      { namePattern: /verif|link.*check|url.*check|confirm.*url/i, forbidden: ["research"] },
      {
        namePattern: /mention.*(find|search)|search.*mention|web.*search/i,
        expected: ["research"],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Website hero prompts — verbatim from use-cases.svelte prompts[]
  // -------------------------------------------------------------------------
  {
    id: "website-release-notes",
    name: "website - draft release notes from GitHub PRs to Notion",
    input:
      "Draft release notes from the GitHub PRs merged this week and add them to my Notion page.",
    expectedCapabilities: ["github", "notion"],
    forbiddenCapabilities: ["research", "slack"],
  },
  {
    id: "website-meeting-prep",
    name: "website - research meeting attendees and send briefing",
    input: "Research the people I'm meeting with and send me a daily morning briefing.",
    expectedCapabilities: ["research", "google-calendar"],
  },
  {
    id: "website-email-to-slack",
    name: "website - Slack summary of unread emails",
    input:
      "Send me a Slack summary of unread emails from the last 24 hours and highlight anything urgent.",
    expectedCapabilities: ["google-gmail", "slack"],
    forbiddenCapabilities: ["email"],
  },
  {
    id: "website-sentry-email",
    name: "website - weekly Sentry error trends email",
    input: "Send me a weekly email summarizing the most frequent errors and trends in Sentry.",
    expectedCapabilities: ["sentry"],
    forbiddenCapabilities: ["research"],
  },
  {
    id: "website-stock-portfolio",
    name: "website - daily stock portfolio email update",
    input: "Track my stock portfolio and send me a daily email update on performance.",
    expectedCapabilities: ["research"],
  },
  {
    id: "website-notion-to-jira",
    name: "website - convert Notion meeting notes to Jira tickets",
    input:
      "Turn my Notion meeting notes into Jira tickets with a clear title, description, owner, and priority.",
    expectedCapabilities: ["notion", "atlassian"],
    forbiddenCapabilities: ["research", "slack"],
  },
  {
    id: "website-meeting-transcripts",
    name: "website - summarize meeting transcripts and post to Slack",
    input: "Summarize my meeting transcripts, outline next steps, and post the update in Slack.",
    expectedCapabilities: ["fathom-get-transcript", "slack"],
  },
  {
    id: "website-competitor-research",
    name: "website - competitor research morning summary",
    input: "Research my competitors and send me a weekday morning summary of important updates.",
    expectedCapabilities: ["research"],
  },

  // -------------------------------------------------------------------------
  // Website use case cards — from use-cases.svelte useCases[]
  // (only cases not already covered by hero prompts above)
  // -------------------------------------------------------------------------
  {
    id: "website-notes-to-linear",
    name: "website - meeting notes to Linear tickets via Notion",
    input:
      "Turn my Notion meeting notes into actionable Linear tickets with owners and priorities.",
    expectedCapabilities: ["notion", "linear"],
    forbiddenCapabilities: ["research", "slack"],
  },
  {
    id: "website-auto-followup",
    name: "website - auto follow-up on unanswered emails",
    input: "Send automatic follow-ups when there's no reply to my emails.",
    expectedCapabilities: ["google-gmail"],
    forbiddenCapabilities: ["research"],
  },
  {
    id: "website-dataset-exploration",
    name: "website - explore uploaded dataset via Google Sheets",
    input:
      "Upload a dataset once and let me explore it anytime through simple questions, with results in Google Sheets.",
    expectedCapabilities: ["google-sheets"],
  },
  {
    id: "website-daily-news",
    name: "website - daily curated news digest",
    input: "Send me a daily digest of relevant industry news curated to my interests.",
    expectedCapabilities: ["research"],
  },
  {
    id: "website-sentry-to-slack",
    name: "website - weekly Sentry trends to Slack",
    input: "Get Sentry error trends summarized and delivered to Slack weekly.",
    expectedCapabilities: ["sentry", "slack"],
    forbiddenCapabilities: ["research"],
  },
  {
    id: "website-brand-mentions",
    name: "website - monitor web for brand mentions",
    input: "Monitor the web for mentions of my brand and alert me when something appears.",
    expectedCapabilities: ["research"],
  },
  {
    id: "website-standup-prep",
    name: "website - weekly update from shipped GitHub work in Notion",
    input: "Generate a clear weekly update based on what I shipped in GitHub, formatted in Notion.",
    expectedCapabilities: ["github", "notion"],
    forbiddenCapabilities: ["research", "slack"],
  },
  {
    id: "website-urgent-emails",
    name: "website - surface urgent emails to Slack",
    input:
      "Surface urgent emails from my Gmail inbox so I don't have to live in it. Notify me in Slack.",
    expectedCapabilities: ["google-gmail", "slack"],
    forbiddenCapabilities: ["email", "research"],
  },
  {
    id: "website-survey-insights",
    name: "website - extract themes from survey responses",
    input:
      "Extract themes and patterns from survey responses in Google Sheets and write findings to Google Docs.",
    expectedCapabilities: ["google-sheets", "google-docs"],
    forbiddenCapabilities: ["research"],
  },
  {
    id: "website-wow-performance",
    name: "website - week-over-week dataset performance tracking",
    input:
      "Track week-over-week performance across multiple datasets in Google Sheets and generate trend insights.",
    expectedCapabilities: ["google-sheets"],
    forbiddenCapabilities: ["research"],
  },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Collects all capability IDs across all agents in a plan result.
 */
function collectAllCapabilities(agents: Array<{ capabilities: string[] }>): Set<string> {
  const all = new Set<string>();
  for (const agent of agents) {
    for (const cap of agent.capabilities) {
      all.add(cap);
    }
  }
  return all;
}

/**
 * Checks per-agent capability rules against plan agents.
 * Returns errors for any rule violations.
 */
function checkAgentRules(
  agents: Array<{ name: string; capabilities: string[] }>,
  rules: AgentCapabilityRule[],
): string[] {
  const errors: string[] = [];
  for (const rule of rules) {
    const matched = agents.filter((a) => rule.namePattern.test(a.name));
    if (matched.length === 0) continue; // No match — rule doesn't apply

    for (const agent of matched) {
      const caps = new Set(agent.capabilities);
      for (const expected of rule.expected ?? []) {
        if (!caps.has(expected)) {
          errors.push(`${agent.name}: missing expected capability "${expected}"`);
        }
      }
      for (const forbidden of rule.forbidden ?? []) {
        if (caps.has(forbidden)) {
          errors.push(`${agent.name}: has forbidden capability "${forbidden}"`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Registrations — each case x 2 modes
// ---------------------------------------------------------------------------

const modes: PlanMode[] = ["task", "workspace"];

export const evals: EvalRegistration[] = cases.flatMap((testCase) =>
  modes.map((mode) =>
    defineEval({
      name: `routing/${mode}/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: async () => {
          return await generatePlan(testCase.input, { mode });
        },
        assert: (result) => {
          const allCaps = collectAllCapabilities(result.agents);

          if (
            testCase.expectedCapabilities.length === 0 &&
            !testCase.forbiddenCapabilities?.length
          ) {
            // Strict "none" case: every agent should have empty capabilities
            const agentsWithCaps = result.agents.filter((a) => a.capabilities.length > 0);
            if (agentsWithCaps.length > 0) {
              throw new Error(
                `Expected all agents to have capabilities: [], but found: ` +
                  agentsWithCaps.map((a) => `${a.name}=[${a.capabilities.join(",")}]`).join(", "),
              );
            }
            return;
          }

          // Check expected capabilities are present
          const missing = testCase.expectedCapabilities.filter((cap) => !allCaps.has(cap));
          if (missing.length > 0) {
            throw new Error(
              `Missing expected capabilities: [${missing.join(", ")}]. ` +
                `Got: [${[...allCaps].join(", ")}]`,
            );
          }

          // Check forbidden capabilities are absent
          const forbidden = testCase.forbiddenCapabilities ?? [];
          const present = forbidden.filter((cap) => allCaps.has(cap));
          if (present.length > 0) {
            throw new Error(
              `Forbidden capabilities present: [${present.join(", ")}]. ` +
                `Got: [${[...allCaps].join(", ")}]`,
            );
          }

          // Check per-agent rules
          if (testCase.agentRules) {
            const ruleErrors = checkAgentRules(result.agents, testCase.agentRules);
            if (ruleErrors.length > 0) {
              throw new Error(`Per-agent rule violations:\n${ruleErrors.join("\n")}`);
            }
          }
        },
        score: (result) => {
          const allCaps = collectAllCapabilities(result.agents);

          if (
            testCase.expectedCapabilities.length === 0 &&
            !testCase.forbiddenCapabilities?.length
          ) {
            // Strict "none" case: score 1 if all agents have empty capabilities
            const allEmpty = result.agents.every((a) => a.capabilities.length === 0);
            return [
              createScore(
                "correct-routing",
                allEmpty ? 1 : 0,
                allEmpty
                  ? "all agents correctly use built-in capabilities only"
                  : `agents incorrectly assigned capabilities: ${result.agents
                      .filter((a) => a.capabilities.length > 0)
                      .map((a) => `${a.name}=[${a.capabilities.join(",")}]`)
                      .join(", ")}`,
              ),
            ];
          }

          const scores = [];

          // Score: expected capabilities present
          const missing = testCase.expectedCapabilities.filter((cap) => !allCaps.has(cap));
          const allExpectedPresent = missing.length === 0;
          scores.push(
            createScore(
              "expected-capabilities",
              allExpectedPresent ? 1 : 0,
              allExpectedPresent
                ? `all expected present: [${testCase.expectedCapabilities.join(", ")}]`
                : `missing: [${missing.join(", ")}]`,
            ),
          );

          // Score: forbidden capabilities absent
          const forbidden = testCase.forbiddenCapabilities ?? [];
          if (forbidden.length > 0) {
            const present = forbidden.filter((cap) => allCaps.has(cap));
            const noneForbidden = present.length === 0;
            scores.push(
              createScore(
                "no-forbidden-capabilities",
                noneForbidden ? 1 : 0,
                noneForbidden
                  ? `correctly avoided: [${forbidden.join(", ")}]`
                  : `incorrectly included: [${present.join(", ")}]`,
              ),
            );
          }

          // Score: per-agent rules
          if (testCase.agentRules) {
            const ruleErrors = checkAgentRules(result.agents, testCase.agentRules);
            const allRulesPass = ruleErrors.length === 0;
            scores.push(
              createScore(
                "per-agent-routing",
                allRulesPass ? 1 : 0,
                allRulesPass
                  ? "all per-agent rules passed"
                  : `violations: ${ruleErrors.join("; ")}`,
              ),
            );
          }

          return scores;
        },
        metadata: {
          mode,
          expectedCapabilities: testCase.expectedCapabilities,
          forbiddenCapabilities: testCase.forbiddenCapabilities,
          promptSnapshot: getSystemPrompt(mode),
          userMessage: formatUserMessage(testCase.input, mode),
        },
      },
    }),
  ),
);
