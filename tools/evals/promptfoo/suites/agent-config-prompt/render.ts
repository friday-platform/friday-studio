#!/usr/bin/env -S deno run -A

/**
 * Renderer for the agent-config-prompt suite.
 *
 * Calls the real `composeAgentPrompt` (apps/atlasd/src/agent-helpers.ts)
 * against each case below, then writes `tests.generated.yaml` for promptfoo.
 *
 * What this eval pins (model-side property):
 *   When a workspace agent has both a config-level `prompt` and a per-step FSM
 *   action `prompt`, both layers reach the model AND the model honors the
 *   config-level guidance.
 *
 * Pinned by unit tests, not this eval:
 *   The structural contract that `composeAgentPrompt` actually concatenates
 *   both layers (`apps/atlasd/src/agent-helpers.test.ts`). The renderer's
 *   `expectInComposed` pre-check still catches a regression in composition
 *   if it slips past the unit test — the renderer fails before promptfoo runs.
 *
 * Workflow: edit `cases` below → `deno task evals:render-promptfoo` →
 * `npx promptfoo eval ...`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasAgent } from "@atlas/config/testing";
import { interpolatePromptPlaceholders } from "@atlas/fsm-engine";
import { stringify } from "@std/yaml";
import { composeAgentPrompt } from "../../../../../apps/atlasd/src/agent-helpers.ts";

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

interface PromptfooTest {
  description: string;
  vars: { user_prompt: string };
  assert: Array<Record<string, unknown>>;
}

const DOCUMENT_CONTEXT = "## Context Facts\n- Current Date: 2026-05-06";

function renderTests(): PromptfooTest[] {
  return cases.map((c) => {
    const composed = composeAgentPrompt(
      { prompt: c.actionPrompt },
      atlasAgent({ agent: "image-generation", prompt: c.agentConfigPrompt }),
      c.prepareConfig ? { config: c.prepareConfig } : undefined,
      DOCUMENT_CONTEXT,
    );

    // Structural pre-check: both layers (post-interpolation) must show up in
    // the composed prompt. If composeAgentPrompt drops a layer, this fails
    // before promptfoo ever calls a model. Mirrors the original eval's
    // `requireLayer` assertion.
    const prepareResult = c.prepareConfig ? { config: c.prepareConfig } : undefined;
    const requireLayer = (label: string, raw: string) => {
      const expected = interpolatePromptPlaceholders(raw, prepareResult);
      if (!composed.includes(expected)) {
        throw new Error(
          `[${c.id}] Composed prompt missing ${label} (post-interpolation).\n` +
            `Expected substring: ${JSON.stringify(expected)}\n` +
            `Got: ${JSON.stringify(composed)}`,
        );
      }
    };
    requireLayer("agentConfig.prompt", c.agentConfigPrompt);
    if (c.actionPrompt) requireLayer("action.prompt", c.actionPrompt);

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
      vars: { user_prompt: composed },
      assert: assertions,
    };
  });
}

const tests = renderTests();
const yaml = stringify(tests, { lineWidth: 100 });
const outPath = join(dirname(fileURLToPath(import.meta.url)), "tests.generated.yaml");
const header = `# AUTO-GENERATED by render.ts. Do NOT edit by hand.
# Source: render.ts (which calls the real composeAgentPrompt).
# Regenerate with: deno task evals:render-promptfoo

`;
await Deno.writeTextFile(outPath, header + yaml);
console.log(`wrote ${tests.length} tests → ${outPath}`);
