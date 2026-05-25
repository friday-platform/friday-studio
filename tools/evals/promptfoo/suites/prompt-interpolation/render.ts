/**
 * Dynamic-tests source for the prompt-interpolation suite.
 *
 * Loaded by promptfoo via `tests: file://render.ts` — promptfoo's
 * dynamic-tests loader, which resolves the module's default export to a
 * `() => TestCase[]` function. Promptfoo runs in Node and loads this file
 * through tsx; the real `interpolatePromptPlaceholders` lives in
 * `@atlas/fsm-engine`, which is a Deno workspace package and is not
 * importable from Node. To bridge:
 *
 *   1. Define the cases as plain data (templates, configs, expectations).
 *   2. `spawnSync("deno", ["eval", ...])` calls the real
 *      `interpolatePromptPlaceholders` in a Deno child and returns the
 *      interpolated strings as JSON over stdout. One subprocess per load —
 *      promptfoo only calls the default export once.
 *   3. Build the `TestCase[]` from the cases + interpolated outputs and
 *      throw on any structural-precheck violation so the eval load fails
 *      loudly rather than shipping a stale prompt.
 *
 * Structural contract for `interpolatePromptPlaceholders` itself is pinned
 * by unit tests in `packages/fsm-engine/tests/prompt-interpolation.test.ts`.
 * The pre-checks here catch a regression in the function that slips past
 * the unit test — the renderer fails before promptfoo calls any model.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notARefusalAsserts } from "../../shared/assertions/not-a-refusal.ts";

interface TestCase {
  description: string;
  vars: Record<string, unknown>;
  assert: Array<Record<string, unknown>>;
}

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

/**
 * Spawn Deno once to interpolate every template against its config. Returns
 * the interpolated string for each case in input order. Single subprocess
 * per load keeps the spawn cost flat regardless of case count.
 */
function interpolateInDeno(
  payload: Array<{ template: string; config: Record<string, unknown> }>,
): string[] {
  // render.ts lives at tools/evals/promptfoo/suites/prompt-interpolation/render.ts —
  // climb five levels for the workspace root so `@atlas/fsm-engine` resolves
  // regardless of where the user invoked promptfoo from.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..", "..", "..");
  const script = `
import { interpolatePromptPlaceholders } from "@atlas/fsm-engine";
const payload = JSON.parse(Deno.args[0]);
const out = payload.map((c) => interpolatePromptPlaceholders(c.template, { config: c.config }));
console.log(JSON.stringify(out));
`;
  const result = spawnSync("deno", ["eval", script, JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(
      `deno eval failed (status=${result.status}, signal=${result.signal ?? "none"}). ` +
        `Is Deno on PATH and the workspace package @atlas/fsm-engine resolvable?`,
    );
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === "string")) {
    throw new Error(`deno eval returned unexpected shape: ${result.stdout}`);
  }
  return parsed;
}

/**
 * Default export consumed by promptfoo's `tests: file://render.ts` loader.
 * Sync — promptfoo awaits the result either way, but sync keeps the stack
 * trace short when a pre-check throws.
 */
export default function render(): TestCase[] {
  const interpolated = interpolateInDeno(
    cases.map((c) => ({ template: c.template, config: c.config })),
  );

  return cases.map((c, i) => {
    const rendered = interpolated[i];
    if (rendered === undefined) {
      throw new Error(`[${c.id}] Deno renderer produced no output for case index ${i}.`);
    }

    // Structural pre-check: catches a regression in the interpolation function
    // itself. If this throws, the load fails — promptfoo never runs.
    for (const needle of c.expectInPrompt) {
      if (!rendered.includes(needle)) {
        throw new Error(
          `[${c.id}] Interpolated prompt missing expected substring "${needle}".\nGot: ${JSON.stringify(rendered)}`,
        );
      }
    }
    for (const forbidden of c.expectNotInPrompt) {
      if (rendered.includes(forbidden)) {
        throw new Error(
          `[${c.id}] Interpolated prompt contains forbidden substring "${forbidden}".\nGot: ${JSON.stringify(rendered)}`,
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
      ...notARefusalAsserts(),
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
      vars: { user_prompt: rendered },
      assert: assertions,
    };
  });
}
