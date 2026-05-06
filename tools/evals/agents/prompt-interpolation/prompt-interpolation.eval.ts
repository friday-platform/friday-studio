/**
 * Prompt-interpolation end-to-end eval.
 *
 * Anchors the behavior PR #199 fixes: agent prompts that reference
 * `{{inputs.x}}` (and the Liquid-style `| default: '...'` filter) are resolved
 * by `interpolatePromptPlaceholders` BEFORE being sent to the LLM, so the
 * model sees real data instead of literal mustache syntax.
 *
 * The unit tests in `packages/fsm-engine/tests/prompt-interpolation.test.ts`
 * pin the substring-substitution contract. This eval pins the downstream
 * effect: an interpolated prompt produces an LLM response that addresses the
 * substituted values, contains no `{{...}}` leakage, and isn't a
 * "missing input" refusal — which is exactly the failure shape the PR cites.
 *
 * Why a real-LLM eval on top of unit tests: a future refactor that kept the
 * function correct but broke the call ordering (e.g. interpolating after the
 * prompt was sent) would not fail the unit tests but WOULD fail this eval,
 * because the LLM's output would suddenly start echoing `{{inputs.x}}` or
 * refusing.
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
  {
    id: "empty-string-fallback",
    name: "empty-string input still triggers the default (Liquid convention)",
    // Forms commonly post "" for unfilled optional fields. Without the
    // empty-string-as-missing rule, the default would never fire here.
    template: "Greet the visitor in {{inputs.language | default: 'English'}}. Keep it to one line.",
    config: { language: "" },
    input: "greeting: empty language",
    expectInPrompt: ["English"],
    expectNotInPrompt: ["{{", "}}"],
    // Hello / hi / welcome — any common English greeting token.
    expectInResponse: [],
  },
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
