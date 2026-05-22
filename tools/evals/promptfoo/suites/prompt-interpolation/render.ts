#!/usr/bin/env -S deno run -A
/**
 * Renderer for the prompt-interpolation suite.
 *
 * Calls the real `interpolatePromptPlaceholders` from `@atlas/fsm-engine`
 * against each case below, then writes `tests.generated.yaml` for promptfoo
 * to consume.
 *
 * Why pre-render instead of calling at eval time:
 * - Promptfoo runs in Node; `@atlas/fsm-engine` is a Deno workspace package.
 *   Spawning a Deno child per test (the live-daemon pattern) is slow and
 *   couples the suite to a subprocess contract.
 * - The eval's value-add is "given a correctly-rendered prompt, the LLM
 *   behaves." The structural contract (`{{x}}` → substitution rules) is
 *   pinned by unit tests in `packages/fsm-engine/tests/prompt-interpolation.test.ts`.
 *   Baking the interpolation output here preserves the model-side property
 *   without re-running the function on every promptfoo call.
 *
 * Workflow: edit `cases` below → `deno task evals:render-promptfoo` →
 * `npx promptfoo eval ...`. The generated file is committed so eval runs
 * are zero-build.
 */

import { interpolatePromptPlaceholders } from "@atlas/fsm-engine";
import { stringify } from "@std/yaml";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Case {
  /** URL-safe slug used in the promptfoo test description. */
  id: string;
  /** Short human-readable description for the promptfoo UI. */
  name: string;
  /** Raw author-written template with `{{...}}` placeholders. */
  template: string;
  /** Mirrors `prepareResult.config` — what the FSM passes at runtime. */
  config: Record<string, unknown>;
  /** Substrings that must appear in the *interpolated* prompt (sanity check). */
  expectInPrompt: string[];
  /** Substrings that must NOT appear in the interpolated prompt. */
  expectNotInPrompt: string[];
  /** Lowercased substrings that should appear in the LLM response. */
  expectInResponse: string[];
}

// Cases mirror tools/evals/agents/prompt-interpolation/prompt-interpolation.eval.ts.
// Add new cases here; the test names in promptfoo will follow `id`.
const cases: Case[] = [
  {
    id: "simple-substitution",
    name: "single {{inputs.x}} resolved against config",
    template: "Summarize the user's request in one short sentence. Request: {{inputs.description}}",
    config: {
      description:
        "I want a workspace that watches my email inbox and forwards finance-related messages to a Slack channel.",
    },
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
    expectInPrompt: ["casual", "Sam", "lunch on Friday"],
    expectNotInPrompt: ["{{", "}}"],
    expectInResponse: ["sam", "lunch"],
  },
  {
    id: "default-filter-fallback",
    name: "default filter kicks in when input is missing",
    template:
      "List three concrete visual elements for {{inputs.style | default: 'classic SNES/GBA pixel art'}} of {{inputs.subject}}.",
    config: { subject: "a brave knight" },
    expectInPrompt: ["classic SNES/GBA pixel art", "brave knight"],
    expectNotInPrompt: ["{{", "}}", "default:"],
    expectInResponse: ["knight"],
  },
  {
    id: "default-filter-override",
    name: "explicit value beats the default",
    template:
      "List two visual elements for {{inputs.style | default: 'classic SNES/GBA pixel art'}} of {{inputs.subject}}.",
    config: { style: "neon cyberpunk", subject: "a brave knight" },
    expectInPrompt: ["neon cyberpunk", "brave knight"],
    expectNotInPrompt: ["{{", "}}", "classic SNES/GBA"],
    expectInResponse: ["knight"],
  },
];

// Build promptfoo test objects. Each rendered prompt becomes `vars.user_prompt`
// in the chat template (prompts/chat.json), so the model sees the same bytes
// the production FSM would have sent.
interface PromptfooTest {
  description: string;
  vars: { user_prompt: string };
  assert: Array<Record<string, unknown>>;
}

function renderTests(): PromptfooTest[] {
  return cases.map((c) => {
    const interpolated = interpolatePromptPlaceholders(c.template, { config: c.config });

    // Structural pre-check: catches a regression in the interpolation function
    // itself. If this throws, the renderer fails — promptfoo never runs.
    for (const needle of c.expectInPrompt) {
      if (!interpolated.includes(needle)) {
        throw new Error(
          `[${c.id}] Interpolated prompt missing expected substring "${needle}".\nGot: ${JSON.stringify(interpolated)}`,
        );
      }
    }
    for (const forbidden of c.expectNotInPrompt) {
      if (interpolated.includes(forbidden)) {
        throw new Error(
          `[${c.id}] Interpolated prompt contains forbidden substring "${forbidden}".\nGot: ${JSON.stringify(interpolated)}`,
        );
      }
    }

    const assertions: Array<Record<string, unknown>> = [
      // NoPlaceholderLeak — the model's response must not echo `{{...}}` back.
      // Use regex with escaped braces because promptfoo passes assertion `value`
      // through Nunjucks, and bare `{{` / `}}` are template syntax errors.
      { type: "not-regex", value: "\\{\\{", metric: "NoPlaceholderLeak" },
      { type: "not-regex", value: "\\}\\}", metric: "NoPlaceholderLeak" },
      // NotARefusal — the model didn't punt with the patterns PR #199 fixed.
      // Patterns mirror the original `notARefusalScore` exactly. Use
      // `not-icontains` (built-in case-insensitive) for simple literals and
      // `not-regex` for genuine alternations. JS RegExp does not support the
      // inline `(?i)` flag, so we either flag-flip via character classes
      // (`[Ii]`) or enumerate alternation branches as separate icontains.
      { type: "not-icontains", value: "required input", metric: "NotARefusal" },
      { type: "not-icontains", value: "missing input", metric: "NotARefusal" },
      { type: "not-icontains", value: "missing required input", metric: "NotARefusal" },
      { type: "not-regex", value: "[nN]o input (was )?(provided|given|supplied)", metric: "NotARefusal" },
      { type: "not-icontains", value: "placeholder", metric: "NotARefusal" },
      { type: "not-icontains", value: "template variable", metric: "NotARefusal" },
      { type: "not-icontains", value: "template reference", metric: "NotARefusal" },
      { type: "not-icontains", value: "unresolved variable", metric: "NotARefusal" },
      { type: "not-icontains", value: "unresolved reference", metric: "NotARefusal" },
      // The canonical "model punts because input looks unresolved" shape from
      // PR #199. Enumerated branches are too many (4 verbs × 2 see-words × 2
      // optional-article × 2 nouns = 32); regex with a leading `[iI]` class
      // covers both cases.
      {
        type: "not-regex",
        value: "[iI] (don't|do not|cannot|can't) (have|see) (the )?(input|value)",
        metric: "NotARefusal",
      },
    ];

    if (c.expectInResponse.length > 0) {
      assertions.push({
        type: "icontains-all",
        value: c.expectInResponse,
        metric: "AddressesData",
      });
    }

    return {
      description: `${c.id} — ${c.name}`,
      vars: { user_prompt: interpolated },
      assert: assertions,
    };
  });
}

const tests = renderTests();
const yaml = stringify(tests, { lineWidth: 100 });

const outPath = join(dirname(fileURLToPath(import.meta.url)), "tests.generated.yaml");
const header = `# AUTO-GENERATED by render.ts. Do NOT edit by hand.
# Source: render.ts (which calls the real interpolatePromptPlaceholders).
# Regenerate with: deno task evals:render-promptfoo

`;
await Deno.writeTextFile(outPath, header + yaml);
console.log(`wrote ${tests.length} tests → ${outPath}`);
