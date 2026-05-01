/**
 * Planner copy quality eval.
 *
 * Tests that `generatePlan()` produces user-facing microcopy — not system specs.
 * Scores across all copy surfaces: workspace purpose, signal labels, resource
 * descriptions, field descriptions, and agent descriptions.
 *
 * Each case runs in both "task" and "workspace" modes.
 */

import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
  type Phase1Result,
  type PlanMode,
} from "../../../../packages/workspace-builder/planner/plan.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createPlannerEvalPlatformModels } from "../../lib/planner-models.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();
const platformModels = createPlannerEvalPlatformModels();

// ---------------------------------------------------------------------------
// Case type
// ---------------------------------------------------------------------------

interface CopyCase extends BaseEvalCase {
  /** Whether this case has resources with field schemas to check. */
  hasResources?: boolean;
  /** Whether this case should have signals (workspace mode only). */
  hasSignals?: boolean;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: CopyCase[] = [
  {
    id: "project-tracker",
    name: "project tracking with Friday + Notion",
    input:
      "Set up a workspace for project tracking. Track tasks in Friday. " +
      "Store project docs in Notion.",
    hasResources: true,
    hasSignals: true,
  },
  {
    id: "github-release-notes",
    name: "weekly GitHub release notes to Notion",
    input:
      "Every Friday, fetch merged PRs from my GitHub repo and publish a " + "summary to Notion.",
    hasSignals: true,
  },
  {
    id: "simple-grocery",
    name: "minimal grocery list",
    input: "Track my grocery list.",
    hasResources: true,
  },
  {
    id: "competitor-monitor",
    name: "multi-agent competitor price monitor",
    input: "Monitor competitor prices on 3 websites and send a daily Slack digest.",
    hasSignals: true,
  },
  {
    id: "reading-log",
    name: "book reading tracker",
    input:
      "Build a workspace to track books I'm reading. Store title, author, " +
      "rating, and status (reading, finished, abandoned).",
    hasResources: true,
  },
  {
    id: "meeting-notes",
    name: "calendar meeting notes",
    input:
      "After each calendar meeting, pull the agenda and attendees and " +
      "write a summary. Keep running meeting notes I can review.",
    hasResources: true,
  },
];

// ---------------------------------------------------------------------------
// LLM judge criteria
// ---------------------------------------------------------------------------

const CRITERIA = {
  purpose:
    "The workspace purpose should read like a product label — what the user " +
    "gets in 1-2 sentences. Score 0 if it mentions implementation details " +
    "like 'resource tables', 'HTTP triggers', 'webhooks', 'natural language', " +
    "'on-demand', 'CRUD', 'JSON Schema', or system plumbing. Score 0 if it " +
    "uses enterprise speak ('robust', 'comprehensive', 'leverage', 'facilitate', " +
    "'streamline'). Score 1 if clean and user-facing.",

  agentDescriptions:
    "Each agent description should be 1 short sentence describing what the " +
    "agent does for the user. Score 0 if ANY description mentions system " +
    "mechanics ('CRUD', 'resource tables', 'interprets the prompt', 'performs " +
    "operations', 'reads and writes'). Score 0 if ANY uses enterprise speak " +
    "('robust', 'comprehensive', 'leverage'). Score 1 if all descriptions " +
    "are clean, concise, user-facing.",

  resourceDescriptions:
    "Resource descriptions should be minimal — the schema fields are shown " +
    "separately in the UI. Score 0 if ANY description uses system narration " +
    "('Agents read and write...', 'Stores all...and allows agents to...'). " +
    "Score 0 if ANY description repeats what's visible in the field list. " +
    "Good examples: 'Project tasks.', 'Project documentation.' " +
    "Score 1 if concise and user-facing.",

  signalLabels:
    "For prompt-driven HTTP triggers (user chats to trigger), the displayLabel " +
    "should be empty string or omitted — NOT 'Manual trigger', 'Webhook', or " +
    "'On-demand'. For scheduled triggers, show the schedule in human terms " +
    "('Every Friday at 9am'). For external integrations, show what fires it " +
    "('On GitHub push'). Score 1 if appropriate, 0 if it leaks plumbing.",
};

// ---------------------------------------------------------------------------
// Rule-based scoring helpers
// ---------------------------------------------------------------------------

const IMPL_LEAK_PATTERNS = [
  /resource\s*table/i,
  /http\s*trigger/i,
  /webhook\s*endpoint/i,
  /crud/i,
  /json\s*schema/i,
  /iso\s*8601/i,
  /natural\s*language/i,
  /on[- ]demand/i,
];

const ENTERPRISE_PATTERNS = [
  /\brobust\b/i,
  /\bcomprehensive\b/i,
  /\bleverage\b/i,
  /\bfacilitate\b/i,
  /\bstreamline\b/i,
];

const SYSTEM_NARRATION_PATTERNS = [
  /agents?\s+(read|write|access|use|interact)/i,
  /triggers?\s+the\s+\w+\s+agent/i,
  /receives?\s+events?\s+from/i,
  /performs?\s+(the\s+)?(appropriate\s+)?operations?/i,
  /interprets?\s+the\s+(natural\s+language\s+)?prompt/i,
];

function hasPatternMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * Check for tautological field descriptions — field name repeated as description.
 * E.g., field `title` described as "Task title" or "The title".
 */
function checkNoTautology(result: Phase1Result): Score {
  const violations: string[] = [];

  for (const resource of result.resources) {
    if (!resource.schema || typeof resource.schema !== "object") continue;
    const props = (resource.schema as Record<string, unknown>).properties;
    if (!props || typeof props !== "object") continue;

    for (const [fieldName, fieldDef] of Object.entries(props as Record<string, unknown>)) {
      if (!fieldDef || typeof fieldDef !== "object") continue;
      const desc = (fieldDef as Record<string, unknown>).description;
      if (typeof desc !== "string") continue;

      // Normalize both to lowercase words
      const nameWords = fieldName.replace(/[_-]/g, " ").toLowerCase().split(/\s+/);
      const descWords = desc
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);

      // Tautology: description is just "[qualifier] fieldName" or "The fieldName"
      const stripped = descWords.filter(
        (w) => !["the", "a", "an", "of", "for", "this", "current", "task", "item"].includes(w),
      );
      if (stripped.length <= nameWords.length && nameWords.every((nw) => stripped.includes(nw))) {
        violations.push(`${resource.slug}.${fieldName}: "${desc}"`);
      }
    }
  }

  return createScore(
    "no-tautology",
    violations.length === 0 ? 1 : 0,
    violations.length === 0
      ? "no tautological field descriptions"
      : `tautological: ${violations.join(", ")}`,
  );
}

/**
 * Check conciseness: purpose ≤ 2 sentences, agent/resource descriptions ≤ 1 sentence.
 */
function checkConciseness(result: Phase1Result): Score {
  const violations: string[] = [];

  const purposeSentences = result.workspace.purpose
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0);
  if (purposeSentences.length > 2) {
    violations.push(`purpose has ${purposeSentences.length} sentences (max 2)`);
  }

  for (const agent of result.agents) {
    const sentences = agent.description.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 1) {
      violations.push(
        `agent "${agent.name}" description has ${sentences.length} sentences (max 1)`,
      );
    }
  }

  for (const resource of result.resources) {
    const sentences = resource.description.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 1) {
      violations.push(
        `resource "${resource.slug}" description has ${sentences.length} sentences (max 1)`,
      );
    }
  }

  return createScore(
    "conciseness",
    violations.length === 0 ? 1 : 0,
    violations.length === 0 ? "all copy within sentence limits" : violations.join("; "),
  );
}

/**
 * Rule-based check for implementation leaks across all copy surfaces.
 */
function checkNoImplLeaks(result: Phase1Result): Score {
  const violations: string[] = [];
  const allPatterns = [...IMPL_LEAK_PATTERNS, ...ENTERPRISE_PATTERNS, ...SYSTEM_NARRATION_PATTERNS];

  // Purpose
  const purposeMatch = hasPatternMatch(result.workspace.purpose, allPatterns);
  if (purposeMatch) violations.push(`purpose: "${purposeMatch}"`);

  // Agent descriptions
  for (const agent of result.agents) {
    const match = hasPatternMatch(agent.description, allPatterns);
    if (match) violations.push(`agent "${agent.name}": "${match}"`);
  }

  // Resource descriptions
  for (const resource of result.resources) {
    const match = hasPatternMatch(resource.description, allPatterns);
    if (match) violations.push(`resource "${resource.slug}": "${match}"`);
  }

  return createScore(
    "no-impl-leaks",
    violations.length === 0 ? 1 : 0,
    violations.length === 0 ? "no implementation leaks detected" : violations.join("; "),
  );
}

/**
 * Check that HTTP signal displayLabels don't say "Manual trigger" or "Webhook".
 */
function checkSignalLabels(result: Phase1Result): Score {
  const BAD_HTTP_LABELS = [/manual\s*trigger/i, /webhook/i, /on[- ]demand/i];
  const violations: string[] = [];

  for (const signal of result.signals) {
    if (signal.signalType !== "http") continue;
    const label = signal.displayLabel ?? "";
    for (const p of BAD_HTTP_LABELS) {
      const match = label.match(p);
      if (match) {
        violations.push(`signal "${signal.name}" displayLabel: "${label}"`);
        break;
      }
    }
  }

  // No HTTP signals = vacuously true
  const httpSignals = result.signals.filter((s) => s.signalType === "http");
  if (httpSignals.length === 0) {
    return createScore("signal-labels", 1, "no HTTP signals to check");
  }

  return createScore(
    "signal-labels",
    violations.length === 0 ? 1 : 0,
    violations.length === 0 ? "HTTP signal labels clean" : violations.join("; "),
  );
}

// ---------------------------------------------------------------------------
// Registrations — each case x 2 modes
// ---------------------------------------------------------------------------

const modes: PlanMode[] = ["task", "workspace"];

export const evals: EvalRegistration[] = cases.flatMap((testCase) =>
  modes.map((mode) =>
    defineEval({
      name: `copy-quality/${mode}/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: async () => {
          return await generatePlan(testCase.input, { platformModels }, { mode });
        },
        score: async (result) => {
          const scores: Score[] = [];

          // --- Rule-based scores (deterministic, cheap) ---
          scores.push(checkNoImplLeaks(result));
          scores.push(checkConciseness(result));
          scores.push(checkNoTautology(result));

          // Signal labels only meaningful in workspace mode
          if (mode === "workspace") {
            scores.push(checkSignalLabels(result));
          }

          // --- LLM judge scores (semantic) ---
          const purposeScore = await llmJudge(result.workspace.purpose, CRITERIA.purpose);
          scores.push({ ...purposeScore, name: "purpose-quality" });

          const agentDescs = result.agents.map((a) => `${a.name}: ${a.description}`).join("\n");
          const agentScore = await llmJudge(agentDescs, CRITERIA.agentDescriptions);
          scores.push({ ...agentScore, name: "agent-desc-quality" });

          if (result.resources.length > 0) {
            const resourceData = result.resources.map((r) => ({
              slug: r.slug,
              description: r.description,
              schema: r.schema,
            }));
            const resourceScore = await llmJudge(resourceData, CRITERIA.resourceDescriptions);
            scores.push({ ...resourceScore, name: "resource-desc-quality" });
          }

          if (mode === "workspace" && result.signals.length > 0) {
            const signalData = result.signals.map((s) => ({
              name: s.name,
              signalType: s.signalType,
              displayLabel: s.displayLabel,
            }));
            const signalScore = await llmJudge(signalData, CRITERIA.signalLabels);
            scores.push({ ...signalScore, name: "signal-label-quality" });
          }

          return scores;
        },
        metadata: {
          mode,
          hasResources: testCase.hasResources,
          hasSignals: testCase.hasSignals,
          promptSnapshot: getSystemPrompt(mode),
          userMessage: formatUserMessage(testCase.input, mode),
        },
      },
    }),
  ),
);
