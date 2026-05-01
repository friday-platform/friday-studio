/**
 * Planner CRUD job suppression eval.
 *
 * Tests that `generatePlan()` does NOT generate signals or agents for
 * resource-only workspaces where CRUD is handled by workspace-chat's
 * resource tools. Also verifies that legitimate jobs (scheduled,
 * external-service, hybrid) are still generated when appropriate.
 *
 * Runs each case in workspace mode only — task mode excludes signals
 * by design, so CRUD suppression is only relevant for workspace plans.
 */

import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
  type Phase1Result,
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

interface CrudSuppressionCase extends BaseEvalCase {
  /**
   * Whether this case should produce zero signals and zero agents.
   * true = resource-only workspace, all CRUD handled by chat.
   * false = legitimate jobs expected (scheduled, external service, hybrid).
   */
  expectZeroJobs: boolean;
  /** Minimum number of resources expected (sanity check). */
  minResources: number;
  /**
   * For hybrid cases: capability IDs that MUST appear on at least one agent.
   * Verifies the legitimate (non-CRUD) part of the plan is preserved.
   */
  expectedCapabilities?: string[];
  /**
   * When true, skip the assert gate — scores still track behavior but
   * failures don't block the run. Used for poisoned-prompt cases where
   * the upstream skill fix addresses the root cause.
   */
  scoreOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: CrudSuppressionCase[] = [
  // -------------------------------------------------------------------------
  // Resource-only — expect zero signals/agents
  // -------------------------------------------------------------------------
  {
    id: "food-tracker",
    name: "resource-only — track my food",
    input:
      "Create a workspace to track my daily food intake. I want to log what I eat with calories and meal type.",
    expectZeroJobs: true,
    minResources: 1,
  },
  {
    id: "grocery-list",
    name: "resource-only — grocery list manager",
    input:
      "Build a workspace that manages my grocery list. I can add items, remove items, and mark items as bought.",
    expectZeroJobs: true,
    minResources: 1,
  },
  {
    id: "reading-log",
    name: "resource-only — book reading tracker",
    input:
      "Set up a workspace to track books I'm reading. Store title, author, status (reading, finished, abandoned), and rating.",
    expectZeroJobs: true,
    minResources: 1,
  },
  {
    id: "workout-log",
    name: "resource-only — workout tracker",
    input:
      "Create a workspace to log my workouts. Track exercise name, sets, reps, weight, and date.",
    expectZeroJobs: true,
    minResources: 1,
  },
  {
    id: "todo-list",
    name: "resource-only — simple todo list",
    input: "I need a workspace for my personal to-do list. Just tasks with a status and priority.",
    expectZeroJobs: true,
    minResources: 1,
  },
  {
    id: "wine-notes",
    name: "resource-only — wine tasting notes",
    input:
      "Make a workspace where I can keep notes on wines I've tried. Name, vintage, region, rating, and tasting notes.",
    expectZeroJobs: true,
    minResources: 1,
  },

  // -------------------------------------------------------------------------
  // Poisoned prompts — conversation agent steers toward signals, planner
  // should still suppress CRUD jobs
  // -------------------------------------------------------------------------
  {
    id: "poisoned-on-demand-signal",
    name: "poisoned — on-demand logging framed as signal",
    input:
      "Create a food intake tracker with on-demand logging. " +
      "The user triggers it manually by submitting what they ate. The signal should accept: " +
      "food_name (string), quantity (string), meal_type (string: breakfast, lunch, dinner, snack). " +
      "Store each entry in a Friday table resource called food_log with columns: " +
      "id (auto), food_name, quantity, meal_type, logged_at (timestamp). " +
      "No notifications, no summaries, no external services. Just store the entry and confirm it was saved.",
    expectZeroJobs: true,
    minResources: 1,
    scoreOnly: true,
  },
  {
    id: "poisoned-manual-trigger-crud",
    name: "poisoned — manual trigger for simple CRUD",
    input:
      "Build a grocery list workspace. User manually triggers adding items. " +
      "The trigger accepts item_name and quantity. Store in a grocery_list table. " +
      "No external services, no notifications. Just add the item.",
    expectZeroJobs: true,
    minResources: 1,
    scoreOnly: true,
  },
  {
    id: "poisoned-on-demand-workout",
    name: "poisoned — on-demand workout logging with schema detail",
    input:
      "Create a workout tracker. On-demand — user submits after each session. " +
      "Accept exercise_name, sets, reps, weight_lbs. Store in a workout_log resource. " +
      "No scheduled jobs, no external services. Just record it.",
    expectZeroJobs: true,
    minResources: 1,
    scoreOnly: true,
  },

  // -------------------------------------------------------------------------
  // Legitimate jobs — expect signals/agents to be preserved
  // -------------------------------------------------------------------------
  {
    id: "daily-meal-plan",
    name: "scheduled — daily meal plan generation",
    input:
      "Create a workspace that generates a daily meal plan every morning at 7am based on my dietary preferences stored in a resource.",
    expectZeroJobs: false,
    minResources: 1,
  },
  {
    id: "food-sync-sheets",
    name: "hybrid — track food and sync to Google Sheets",
    input:
      "Track my food intake in Friday and sync a weekly nutrition summary to my Google Sheet every Sunday.",
    expectZeroJobs: false,
    minResources: 1,
    expectedCapabilities: ["google-sheets"],
  },
  {
    id: "inventory-slack-alert",
    name: "hybrid — inventory tracker with Slack alerts",
    input:
      "Track my pantry inventory. When I mark an item as low, send a notification to my #groceries Slack channel.",
    expectZeroJobs: false,
    minResources: 1,
    expectedCapabilities: ["slack"],
  },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Check if an agent has only built-in capabilities (no external services). */
function isBuiltInOnly(agent: { capabilities: string[] }): boolean {
  return agent.capabilities.length === 0;
}

/**
 * Detect CRUD-pattern agents: built-in capabilities only, name/description
 * suggests basic resource operations.
 */
function looksLikeCrudAgent(agent: {
  name: string;
  description: string;
  capabilities: string[];
}): boolean {
  if (!isBuiltInOnly(agent)) return false;
  const crudPatterns =
    /\b(add|create|insert|update|edit|modify|delete|remove|read|query|list|log|track|manage|record)\b/i;
  return crudPatterns.test(agent.name) || crudPatterns.test(agent.description);
}

/** Collect all capabilities across agents. */
function collectAllCapabilities(agents: Array<{ capabilities: string[] }>): Set<string> {
  const all = new Set<string>();
  for (const agent of agents) {
    for (const cap of agent.capabilities) all.add(cap);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<Phase1Result>({
    name: `crud-suppression/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async () => {
        return await generatePlan(testCase.input, { platformModels }, { mode: "workspace" });
      },
      assert: testCase.scoreOnly
        ? undefined
        : (result) => {
            // Resource-only cases must have zero signals and zero agents
            if (testCase.expectZeroJobs) {
              if (result.signals.length > 0) {
                throw new Error(
                  `Expected zero signals for resource-only workspace, got ${result.signals.length}: ` +
                    result.signals.map((s) => s.name).join(", "),
                );
              }
              if (result.agents.length > 0) {
                throw new Error(
                  `Expected zero agents for resource-only workspace, got ${result.agents.length}: ` +
                    result.agents.map((a) => `${a.name} [${a.capabilities.join(",")}]`).join(", "),
                );
              }
            }

            // All cases must declare resources
            if (result.resources.length < testCase.minResources) {
              throw new Error(
                `Expected at least ${testCase.minResources} resource(s), got ${result.resources.length}`,
              );
            }
          },
      score: (result) => {
        const scores = [];

        if (testCase.expectZeroJobs) {
          // Score: zero signals
          scores.push(
            createScore(
              "zero-signals",
              result.signals.length === 0 ? 1 : 0,
              result.signals.length === 0
                ? "correctly generated zero signals"
                : `generated ${result.signals.length} signal(s): ${result.signals.map((s) => s.name).join(", ")}`,
            ),
          );

          // Score: zero agents
          scores.push(
            createScore(
              "zero-agents",
              result.agents.length === 0 ? 1 : 0,
              result.agents.length === 0
                ? "correctly generated zero agents"
                : `generated ${result.agents.length} agent(s): ${result.agents.map((a) => a.name).join(", ")}`,
            ),
          );

          // Score: no CRUD-pattern agents (more specific — catches the exact failure mode)
          const crudAgents = result.agents.filter(looksLikeCrudAgent);
          scores.push(
            createScore(
              "no-crud-agents",
              crudAgents.length === 0 ? 1 : 0,
              crudAgents.length === 0
                ? "no CRUD-pattern agents detected"
                : `CRUD-pattern agents: ${crudAgents.map((a) => a.name).join(", ")}`,
            ),
          );
        } else {
          // Legitimate job cases: verify jobs exist
          scores.push(
            createScore(
              "has-signals",
              result.signals.length > 0 ? 1 : 0,
              result.signals.length > 0
                ? `generated ${result.signals.length} signal(s)`
                : "missing expected signals",
            ),
          );

          scores.push(
            createScore(
              "has-agents",
              result.agents.length > 0 ? 1 : 0,
              result.agents.length > 0
                ? `generated ${result.agents.length} agent(s)`
                : "missing expected agents",
            ),
          );

          // Check expected capabilities for hybrid cases
          if (testCase.expectedCapabilities) {
            const allCaps = collectAllCapabilities(result.agents);
            const missing = testCase.expectedCapabilities.filter((c) => !allCaps.has(c));
            scores.push(
              createScore(
                "expected-capabilities",
                missing.length === 0 ? 1 : 0,
                missing.length === 0
                  ? `all expected capabilities present: [${testCase.expectedCapabilities.join(", ")}]`
                  : `missing capabilities: [${missing.join(", ")}]`,
              ),
            );
          }
        }

        // All cases: resources must be declared
        scores.push(
          createScore(
            "has-resources",
            result.resources.length >= testCase.minResources ? 1 : 0,
            `expected >= ${testCase.minResources} resource(s), got ${result.resources.length}`,
          ),
        );

        return scores;
      },
      metadata: {
        expectZeroJobs: testCase.expectZeroJobs,
        minResources: testCase.minResources,
        expectedCapabilities: testCase.expectedCapabilities,
        promptSnapshot: getSystemPrompt("workspace"),
        userMessage: formatUserMessage(testCase.input, "workspace"),
      },
    },
  }),
);
