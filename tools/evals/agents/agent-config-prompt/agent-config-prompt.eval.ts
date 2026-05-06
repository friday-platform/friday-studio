/**
 * Model-side property for `composeAgentPrompt` (in `apps/atlasd/src/agent-helpers.ts`):
 * when a workspace agent has both a config-level `prompt` and a per-step FSM
 * action `prompt`, the LLM honors both layers. The structural contract
 * (config-then-action, both reach the model) is pinned in
 * `apps/atlasd/src/agent-helpers.test.ts`; this eval verifies the model
 * actually obeys the config-level guidance once it arrives.
 *
 * Scope: calls `composeAgentPrompt` directly. A regression that bypasses the
 * helper inside `runtime.executeAgent` would not be caught here.
 */

import { atlasAgent } from "@atlas/config/testing";
import { registry, traceModel } from "@atlas/llm";
import { generateText } from "ai";
import { composeAgentPrompt } from "../../../../apps/atlasd/src/agent-helpers.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

// Haiku: cheap, fast, and instruction-following enough to make this signal
// crisp. If Haiku ignores the system-style guidance, that's the bug.
const MODEL_ID = "anthropic:claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/** The config-prompt instruction landed: response contains the required token. */
function honorsConfigPromptScore(text: string, requiredToken: string): Score {
  const present = text.includes(requiredToken);
  return createScore(
    "HonorsConfigPrompt",
    present ? 1 : 0,
    present
      ? `Response contains required token "${requiredToken}"`
      : `Response missing required token "${requiredToken}" — config-prompt instruction was likely dropped`,
  );
}

/** The action-prompt task also landed: response addresses the per-step task. */
function addressesActionPromptScore(text: string, keywords: string[]): Score {
  const lower = text.toLowerCase();
  const matches = keywords.filter((k) => lower.includes(k.toLowerCase()));
  const value = matches.length / keywords.length;
  return createScore(
    "AddressesActionPrompt",
    value,
    `${matches.length}/${keywords.length} action-prompt keywords matched: [${keywords.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface ConfigPromptCase extends BaseEvalCase {
  /** Workspace-level guidance — this is what the bug used to drop. */
  agentConfigPrompt: string;
  /** Per-step task prompt from the FSM action. Omit for the config-only path. */
  actionPrompt?: string;
  /** Optional `prepareResult.config` for `{{inputs.x}}` interpolation. */
  prepareConfig?: Record<string, unknown>;
  /** Token the config-prompt instructs the model to emit. */
  requiredToken: string;
  /** Keywords that prove the action-prompt task was also addressed. */
  actionPromptKeywords: string[];
}

const cases: ConfigPromptCase[] = [
  {
    id: "marker-token",
    name: "config prompt instruction (marker token) is honored alongside action prompt",
    // Marker tokens are the firmest signal we can get: Haiku reproduces a
    // pinned literal far more faithfully than a paraphrasable directive.
    agentConfigPrompt:
      'You are a helpful assistant. Always end every response with the literal token "NEON_GREEN_OK" on its own line. This is a non-negotiable formatting rule.',
    actionPrompt: "Introduce yourself in one short sentence.",
    requiredToken: "NEON_GREEN_OK",
    actionPromptKeywords: ["assistant"],
    input: "marker-token: introduce yourself",
  },
  {
    id: "interpolated-action-with-config-rule",
    name: "config prompt is honored when action prompt uses {{inputs.x}} interpolation",
    agentConfigPrompt:
      'You answer questions about visual design. Always include the literal token "BG_NEON_GREEN" verbatim somewhere in your response.',
    actionPrompt: "Describe a {{inputs.subject}} sprite in two sentences.",
    prepareConfig: { subject: "robot chef" },
    requiredToken: "BG_NEON_GREEN",
    actionPromptKeywords: ["robot", "chef"],
    input: "interpolated: robot chef sprite",
  },
  {
    id: "config-prompt-alone",
    name: "config prompt drives behavior when no action prompt is set",
    agentConfigPrompt:
      'Reply with exactly one short sentence introducing yourself, and append the literal token "SOLO_OK" at the end.',
    requiredToken: "SOLO_OK",
    actionPromptKeywords: [],
    input: "solo: config-only path",
  },
];

// ---------------------------------------------------------------------------
// Run helper
// ---------------------------------------------------------------------------

interface RunOutcome {
  /** The fully-composed prompt sent to the LLM (config + action + context). */
  composedPrompt: string;
  /** The LLM's response text. */
  responseText: string;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

async function runConfigPromptCase(testCase: ConfigPromptCase): Promise<RunOutcome> {
  const composedPrompt = composeAgentPrompt(
    { prompt: testCase.actionPrompt },
    atlasAgent({ agent: "image-generation", prompt: testCase.agentConfigPrompt }),
    testCase.prepareConfig ? { config: testCase.prepareConfig } : undefined,
    "## Context Facts\n- Current Date: 2026-05-06",
  );

  const start = performance.now();
  const result = await generateText({
    model: traceModel(registry.languageModel(MODEL_ID)),
    // No system message: the whole point is that the agent config prompt acts
    // as the system-style instruction. Adding one here would mask the bug.
    prompt: composedPrompt,
    maxOutputTokens: 200,
    temperature: 0,
  });
  const latencyMs = performance.now() - start;

  return { composedPrompt, responseText: result.text, latencyMs };
}

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<RunOutcome>({
    name: `agent-config-prompt/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: () => runConfigPromptCase(testCase),
      // Structural sanity: both prompt layers must appear in the composed
      // prompt before we even ask the model. Catches a regression in
      // composeAgentPrompt itself — separately from the LLM-side score.
      // Both layers must appear in the composed prompt before we ask the
      // model — substring-match the prefix up to the first `{{`, since
      // composeAgentPrompt interpolates placeholders out.
      assert: ({ composedPrompt }) => {
        const requirePrefix = (label: string, raw: string) => {
          const prefix = raw.split("{{")[0] ?? "";
          if (prefix && !composedPrompt.includes(prefix)) {
            throw new Error(
              `Composed prompt missing ${label} prefix.\nGot: ${JSON.stringify(composedPrompt)}`,
            );
          }
        };
        requirePrefix("agentConfig.prompt", testCase.agentConfigPrompt);
        if (testCase.actionPrompt) requirePrefix("action.prompt", testCase.actionPrompt);
      },
      score: ({ responseText }) => {
        const scores: Score[] = [honorsConfigPromptScore(responseText, testCase.requiredToken)];
        if (testCase.actionPromptKeywords.length > 0) {
          scores.push(addressesActionPromptScore(responseText, testCase.actionPromptKeywords));
        }
        return scores;
      },
      metadata: {
        case: testCase.id,
        agentConfigPrompt: testCase.agentConfigPrompt,
        actionPrompt: testCase.actionPrompt,
        requiredToken: testCase.requiredToken,
        model: MODEL_ID,
      },
    },
  }),
);
