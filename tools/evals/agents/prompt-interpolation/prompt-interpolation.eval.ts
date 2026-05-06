/**
 * Prompt-interpolation downstream eval.
 *
 * The unit tests in `packages/fsm-engine/tests/prompt-interpolation.test.ts`
 * already pin the substring-substitution contract. This eval covers a
 * complementary, model-side property: when the rendered prompt is sent to a
 * real LLM, the response addresses the substituted values, doesn't leak
 * `{{...}}` syntax, and isn't a "missing input" refusal — the failure shape
 * cited by PR #199.
 *
 * Scope note: this eval calls `interpolatePromptPlaceholders` directly, NOT
 * via `runtime.ts:executeAgent`, so a regression that removed the
 * interpolation call from the agent-action path would not be caught here.
 * That end-to-end coverage lives in the daemon-side smoke test documented in
 * the PR. Treat this eval as "given a correctly-rendered prompt, the LLM
 * behaves," not "the FSM call site is wired correctly."
 */

import { interpolatePromptPlaceholders } from "@atlas/fsm-engine";
import { registry, traceModel } from "@atlas/llm";
import { generateText } from "ai";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

// Haiku: cheap, fast, and faithful enough to surface placeholder leakage.
const MODEL_ID = "anthropic:claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/**
 * Penalize raw mustache leak in the LLM output. The whole point of
 * interpolation is that the model never sees `{{...}}`; if the response
 * contains the syntax, either interpolation didn't run, or the model is
 * echoing the prompt back at us — both regressions worth catching.
 */
function noPlaceholderLeakScore(text: string): Score {
  const hasOpenBraces = text.includes("{{");
  const hasCloseBraces = text.includes("}}");
  if (hasOpenBraces || hasCloseBraces) {
    return createScore("NoPlaceholderLeak", 0, "Output contains literal {{ or }}");
  }
  return createScore("NoPlaceholderLeak", 1, "No mustache syntax in output");
}

/**
 * Penalize the specific refusal shape the PR description cites:
 * "required input values are missing" / "no input was provided" / similar.
 * These are the LLM behaviors that motivated the fix; a successful
 * interpolation prevents them.
 */
function notARefusalScore(text: string): Score {
  const lower = text.toLowerCase();
  const refusalPatterns = [
    /required input/,
    /missing (required )?input/,
    /no input (was )?(provided|given|supplied)/,
    /placeholder/,
    /template (variable|reference)/,
    /unresolved (variable|reference)/,
    /i (don't|do not|cannot|can't) (have|see) (the )?(input|value)/,
  ];
  for (const pattern of refusalPatterns) {
    if (pattern.test(lower)) {
      return createScore("NotARefusal", 0, `Matched refusal pattern: ${pattern}`);
    }
  }
  return createScore("NotARefusal", 1, "No refusal markers");
}

/**
 * Rule-based: did the response actually mention the data we substituted in?
 * Lowercased substring match, all keywords required.
 */
function addressesDataScore(text: string, keywords: string[]): Score {
  const lower = text.toLowerCase();
  const matches = keywords.filter((k) => lower.includes(k.toLowerCase()));
  const value = matches.length / keywords.length;
  return createScore(
    "AddressesData",
    value,
    `${matches.length}/${keywords.length} keywords matched: [${keywords.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface InterpolationCase extends BaseEvalCase {
  /** Raw author-written agent prompt (with placeholders). */
  template: string;
  /** prepareResult.config — what the FSM would pass at runtime. */
  config: Record<string, unknown>;
  /** Expected substring(s) in the *interpolated* prompt — sanity check on the function. */
  expectInPrompt: string[];
  /** Substrings that must NOT appear in the interpolated prompt. */
  expectNotInPrompt: string[];
  /** Expected substring(s) in the LLM response (lowercased match). */
  expectInResponse: string[];
}

const cases: InterpolationCase[] = [
  {
    id: "simple-substitution",
    name: "single {{inputs.x}} resolved against config",
    // Mirrors the workspace-chat save_entry shape from the PR description.
    template: "Summarize the user's request in one short sentence. Request: {{inputs.description}}",
    config: {
      description:
        "I want a workspace that watches my email inbox and forwards finance-related messages to a Slack channel.",
    },
    input: "save-entry: forward finance email",
    expectInPrompt: ["watches my email inbox", "finance-related"],
    expectNotInPrompt: ["{{", "}}"],
    expectInResponse: ["finance"],
  },
  {
    id: "dotted-path",
    name: "nested object accessed via dotted path",
    template:
      "Write one sentence introducing {{inputs.author.name}}, who is a {{inputs.author.role}}.",
    config: { author: { name: "Ada Lovelace", role: "mathematician" } },
    input: "intro: Ada Lovelace",
    expectInPrompt: ["Ada Lovelace", "mathematician"],
    expectNotInPrompt: ["{{", "}}"],
    expectInResponse: ["ada"],
  },
  {
    id: "multi-placeholder",
    name: "multiple placeholders all resolved",
    template:
      "Draft a {{inputs.tone}} one-sentence message to {{inputs.recipient}} about {{inputs.topic}}.",
    config: { tone: "casual", recipient: "Sam", topic: "lunch on Friday" },
    input: "draft: lunch message to Sam",
    expectInPrompt: ["casual", "Sam", "lunch on Friday"],
    expectNotInPrompt: ["{{", "}}"],
    expectInResponse: ["sam", "lunch"],
  },
  {
    id: "default-filter-fallback",
    name: "default filter kicks in when input is missing",
    // Pulled from the PR description's example: a workspace UI form that
    // doesn't pass `style` should still produce a usable prompt.
    template:
      "List three concrete visual elements for {{inputs.style | default: 'classic SNES/GBA pixel art'}} of {{inputs.subject}}.",
    config: { subject: "a brave knight" },
    input: "art-prompt: brave knight (no style)",
    expectInPrompt: ["classic SNES/GBA pixel art", "brave knight"],
    // Critical assertion: the un-piped placeholder syntax must not leak.
    expectNotInPrompt: ["{{", "}}", "default:"],
    // Knight is the subject; we don't insist on "snes" because Haiku may
    // paraphrase ("16-bit", "retro pixel"). Subject is the firmer anchor.
    expectInResponse: ["knight"],
  },
  {
    id: "default-filter-override",
    name: "explicit value beats the default",
    template:
      "List two visual elements for {{inputs.style | default: 'classic SNES/GBA pixel art'}} of {{inputs.subject}}.",
    config: { style: "neon cyberpunk", subject: "a brave knight" },
    input: "art-prompt: cyberpunk knight",
    // The default literal should NOT appear — value won.
    expectInPrompt: ["neon cyberpunk", "brave knight"],
    expectNotInPrompt: ["{{", "}}", "classic SNES/GBA"],
    expectInResponse: ["knight"],
  },
  // Empty-string-as-missing semantics are covered by unit tests in
  // prompt-interpolation.test.ts; an LLM run adds nothing the no-leak /
  // no-refusal scorers don't already give us on every other case.
];

// ---------------------------------------------------------------------------
// Run helper
// ---------------------------------------------------------------------------

interface RunOutcome {
  /** The fully-interpolated prompt sent to the LLM. */
  interpolatedPrompt: string;
  /** The LLM's response text. */
  responseText: string;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

async function runInterpolationCase(testCase: InterpolationCase): Promise<RunOutcome> {
  const interpolatedPrompt = interpolatePromptPlaceholders(testCase.template, {
    config: testCase.config,
  });

  const start = performance.now();
  const result = await generateText({
    model: traceModel(registry.languageModel(MODEL_ID)),
    // Steer Haiku to short, on-task output so keyword scoring isn't noisy.
    system:
      "You follow the user's instruction precisely and respond in plain prose. Keep responses short.",
    prompt: interpolatedPrompt,
    maxOutputTokens: 200,
    // Determinism: keyword scoring is paraphrase-sensitive. Pinning to 0
    // doesn't fully eliminate variance (server-side sampling can still
    // diverge on ties) but materially reduces flake.
    temperature: 0,
  });
  const latencyMs = performance.now() - start;

  return { interpolatedPrompt, responseText: result.text, latencyMs };
}

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<RunOutcome>({
    name: `prompt-interpolation/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: () => runInterpolationCase(testCase),
      // Assert the function-level contract first — if interpolation didn't
      // do its job, scoring the LLM output is meaningless.
      assert: ({ interpolatedPrompt }) => {
        for (const needle of testCase.expectInPrompt) {
          if (!interpolatedPrompt.includes(needle)) {
            throw new Error(
              `Interpolated prompt missing expected substring "${needle}". ` +
                `Got: ${JSON.stringify(interpolatedPrompt)}`,
            );
          }
        }
        for (const forbidden of testCase.expectNotInPrompt) {
          if (interpolatedPrompt.includes(forbidden)) {
            throw new Error(
              `Interpolated prompt contains forbidden substring "${forbidden}". ` +
                `Got: ${JSON.stringify(interpolatedPrompt)}`,
            );
          }
        }
      },
      score: ({ responseText }) => {
        const scores: Score[] = [
          noPlaceholderLeakScore(responseText),
          notARefusalScore(responseText),
        ];
        if (testCase.expectInResponse.length > 0) {
          scores.push(addressesDataScore(responseText, testCase.expectInResponse));
        }
        return scores;
      },
      metadata: {
        case: testCase.id,
        template: testCase.template,
        config: testCase.config,
        model: MODEL_ID,
      },
    },
  }),
);
