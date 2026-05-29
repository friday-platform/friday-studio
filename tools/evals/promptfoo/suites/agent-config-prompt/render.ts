/**
 * Dynamic-tests source for the agent-config-prompt suite.
 *
 * Loaded by promptfoo via `tests: file://render.ts` — promptfoo's
 * dynamic-tests loader, which resolves the module's default export to a
 * `() => TestCase[]` function. Promptfoo runs in Node and loads this file
 * through tsx; the real `composeAgentPrompt` lives in
 * `apps/atlasd/src/agent-helpers.ts` (Deno workspace) and is not importable
 * from Node. To bridge:
 *
 *   1. Define the cases as plain data (config prompt, action prompt, etc.).
 *   2. `spawnSync("deno", ["eval", ...])` calls the real `composeAgentPrompt`
 *      + `interpolatePromptPlaceholders` in a Deno child and returns, per
 *      case, `{ composed, interpolatedConfig, interpolatedAction }` as JSON
 *      over stdout. One subprocess per load — promptfoo only calls the
 *      default export once.
 *   3. Build the `TestCase[]` from the case data + composed strings, and
 *      throw on any structural-precheck violation so the load fails loudly
 *      rather than shipping a stale prompt.
 *
 * What this eval pins (model-side property):
 *   When a workspace agent has both a config-level `prompt` and a per-step FSM
 *   action `prompt`, both layers reach the model AND the model honors the
 *   config-level guidance.
 *
 * Pinned by unit tests, not this eval:
 *   The structural contract that `composeAgentPrompt` actually concatenates
 *   both layers (`apps/atlasd/src/agent-helpers.test.ts`). The pre-check
 *   here still catches a regression in composition that slips past the unit
 *   test — the load fails before promptfoo ever calls a model.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface TestCase {
  description: string;
  vars: Record<string, unknown>;
  assert: Array<Record<string, unknown>>;
}

interface Case {
  /** URL-safe slug. */
  id: string;
  /** Human-readable description. */
  name: string;
  /** Workspace-level guidance — the bit that historically got dropped. */
  agentConfigPrompt: string;
  /** Per-step task prompt from the FSM action (omit for config-only). */
  actionPrompt?: string;
  /** Optional `prepareResult.config` for `{{inputs.x}}` interpolation. */
  prepareConfig?: Record<string, unknown>;
  /** Literal token the config-prompt instructs the model to emit. */
  requiredToken: string;
  /** Keywords that prove the action-prompt task was also addressed. */
  actionPromptKeywords: string[];
}

// Cases mirror tools/evals/agents/agent-config-prompt/agent-config-prompt.eval.ts.
const cases: Case[] = [
  {
    id: "marker-token",
    name: "config prompt instruction (marker token) is honored alongside action prompt",
    agentConfigPrompt:
      'You are a helpful assistant. Always end every response with the literal token "NEON_GREEN_OK" on its own line. This is a non-negotiable formatting rule.',
    actionPrompt: "Introduce yourself in one short sentence.",
    requiredToken: "NEON_GREEN_OK",
    actionPromptKeywords: ["assistant"],
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
  },
  {
    id: "config-prompt-alone",
    name: "config prompt drives behavior when no action prompt is set",
    agentConfigPrompt:
      'Reply with exactly one short sentence introducing yourself, and append the literal token "SOLO_OK" at the end.',
    requiredToken: "SOLO_OK",
    actionPromptKeywords: [],
  },
];

const DOCUMENT_CONTEXT = "## Context Facts\n- Current Date: 2026-05-06";

interface DenoCasePayload {
  agentConfigPrompt: string;
  actionPrompt: string | null;
  prepareConfig: Record<string, unknown> | null;
  documentContext: string;
}

interface DenoCaseOutput {
  composed: string;
  interpolatedConfigPrompt: string;
  interpolatedActionPrompt: string | null;
}

/**
 * Spawn Deno once to compose every case via the real `composeAgentPrompt`
 * + `interpolatePromptPlaceholders`. Returns per-case composed prompts AND
 * the post-interpolation strings used by the structural pre-check.
 */
function composeInDeno(payload: DenoCasePayload[]): DenoCaseOutput[] {
  // render.ts lives at tools/evals/promptfoo/suites/agent-config-prompt/render.ts —
  // climb five levels for the workspace root so @atlas/* + agent-helpers.ts
  // resolve regardless of where the user invoked promptfoo from.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..", "..", "..");
  const agentHelpersUrl = pathToFileURL(resolve(repoRoot, "apps/atlasd/src/agent-helpers.ts")).href;
  const script = `
import { atlasAgent } from "@atlas/config/testing";
import { interpolatePromptPlaceholders } from "@atlas/fsm-engine";
import { composeAgentPrompt } from "${agentHelpersUrl}";
const payload = JSON.parse(Deno.args[0]);
const out = payload.map((c) => {
  const prepareResult = c.prepareConfig ? { config: c.prepareConfig } : undefined;
  const composed = composeAgentPrompt(
    { prompt: c.actionPrompt ?? undefined },
    atlasAgent({ agent: "image-generation", prompt: c.agentConfigPrompt }),
    prepareResult,
    c.documentContext,
  );
  return {
    composed,
    interpolatedConfigPrompt: interpolatePromptPlaceholders(c.agentConfigPrompt, prepareResult),
    interpolatedActionPrompt: c.actionPrompt
      ? interpolatePromptPlaceholders(c.actionPrompt, prepareResult)
      : null,
  };
});
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
        `Is Deno on PATH and the workspace packages @atlas/config/testing + @atlas/fsm-engine resolvable?`,
    );
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every(isDenoCaseOutput)) {
    throw new Error(`deno eval returned unexpected shape: ${result.stdout}`);
  }
  return parsed;
}

function isDenoCaseOutput(value: unknown): value is DenoCaseOutput {
  if (typeof value !== "object" || value === null) return false;
  if (!("composed" in value) || typeof value.composed !== "string") return false;
  if (
    !("interpolatedConfigPrompt" in value) ||
    typeof value.interpolatedConfigPrompt !== "string"
  ) {
    return false;
  }
  if (!("interpolatedActionPrompt" in value)) return false;
  return (
    value.interpolatedActionPrompt === null || typeof value.interpolatedActionPrompt === "string"
  );
}

/**
 * Default export consumed by promptfoo's `tests: file://render.ts` loader.
 * Sync — promptfoo awaits the result either way, but sync keeps the stack
 * trace short when a pre-check throws.
 */
export default function render(): TestCase[] {
  const composed = composeInDeno(
    cases.map((c) => ({
      agentConfigPrompt: c.agentConfigPrompt,
      actionPrompt: c.actionPrompt ?? null,
      prepareConfig: c.prepareConfig ?? null,
      documentContext: DOCUMENT_CONTEXT,
    })),
  );

  return cases.map((c, i) => {
    const out = composed[i];
    if (out === undefined) {
      throw new Error(`[${c.id}] Deno renderer produced no output for case index ${i}.`);
    }

    // Structural pre-check: both layers (post-interpolation) must show up in
    // the composed prompt. If composeAgentPrompt drops a layer, this fails
    // before promptfoo ever calls a model. Mirrors the original eval's
    // `requireLayer` assertion.
    if (!out.composed.includes(out.interpolatedConfigPrompt)) {
      throw new Error(
        `[${c.id}] Composed prompt missing agentConfig.prompt (post-interpolation).\n` +
          `Expected substring: ${JSON.stringify(out.interpolatedConfigPrompt)}\n` +
          `Got: ${JSON.stringify(out.composed)}`,
      );
    }
    if (c.actionPrompt && out.interpolatedActionPrompt !== null) {
      if (!out.composed.includes(out.interpolatedActionPrompt)) {
        throw new Error(
          `[${c.id}] Composed prompt missing action.prompt (post-interpolation).\n` +
            `Expected substring: ${JSON.stringify(out.interpolatedActionPrompt)}\n` +
            `Got: ${JSON.stringify(out.composed)}`,
        );
      }
    }

    const assertions: Array<Record<string, unknown>> = [
      // HonorsConfigPrompt — the literal marker token must appear in the
      // model's response. If it doesn't, the config-prompt layer was either
      // dropped from the composed prompt or ignored by the model.
      { type: "contains", value: c.requiredToken, metric: "HonorsConfigPrompt" },
    ];

    if (c.actionPromptKeywords.length > 0) {
      assertions.push({
        type: "icontains-all",
        value: c.actionPromptKeywords,
        metric: "AddressesActionPrompt",
      });
    }

    return {
      description: `${c.id} — ${c.name}`,
      vars: { user_prompt: out.composed },
      assert: assertions,
    };
  });
}
