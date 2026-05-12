#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Load-skill injection eval.
 *
 * Tests whether `load_skill`'s skill body actually constrains the calling
 * agent's output. The architecture returns the skill body as a
 * tool-result content block — the model treats that as evidence, not as
 * a binding rule. Em-dashes are the signal: the user's diagnostic chat
 * showed "No em dashes" in the loaded stop-slop skill but the parent
 * agent still emitted em-dashes in three subsequent writes.
 *
 * Variants:
 *   A — tool-result-only          (today's behavior)
 *   B — tool-result + <system-reminder> wrapping the body in every
 *       subsequent user turn      (proposed fix)
 *
 * **A note on A's behavior in this eval.** Sonnet 4.5 with a minimal
 * synthetic system prompt tends to honor the buried em-dash rule from
 * the tool-result slot — the failure the user observed in production
 * needed the full ~50KB workspace-chat system prompt to dilute the
 * skill enough that it leaked. We can't easily replicate that here
 * without coupling the eval to a moving target. The eval still locks
 * in three things worth catching:
 *
 *   1. B reliably produces zero em-dashes on turn 1 (mechanism).
 *   2. B reliably produces zero em-dashes on turn 3 (persistence —
 *      a one-shot reminder would fail this).
 *   3. B is never worse than A (no-regression check — if future model
 *      changes flip the floor, this surfaces it).
 *
 * The A-baseline result is reported but always passes; its em-dash
 * counts are the tripwire for the inverse case (model regresses to
 * leaking em-dashes from tool-result slots, which would mean the
 * proposed fix becomes load-bearing rather than defensive).
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const EM_DASH_RE = /—/g;

function countEmDashes(text: string): number {
  const matches = text.match(EM_DASH_RE);
  return matches ? matches.length : 0;
}

const SKILL_NAME = "@test/stop-slop";

const SKILL_DESCRIPTION =
  "Remove AI writing patterns from prose. Use when drafting, editing, or " +
  "reviewing text to eliminate predictable AI tells.";

/**
 * Verbose multi-rule skill body that mimics the structure of the real
 * stop-slop skill the user observed failing. The em-dash rule is one
 * bullet among many — that's the diagnostic structure: a focused,
 * single-rule skill ("just no em-dashes") is honored even from a
 * tool-result slot, but a buried rule under noise is not. Em-dashes
 * are rule #6's last sentence, mirroring the real skill exactly.
 */
const SKILL_INSTRUCTIONS = `# Stop Slop

Eliminate predictable AI writing patterns from prose.

## Core Rules

1. **Cut filler phrases.** Remove throat-clearing openers, emphasis crutches, and all adverbs.

2. **Break formulaic structures.** Avoid binary contrasts, negative listings, dramatic fragmentation, rhetorical setups, false agency.

3. **Use active voice.** Every sentence needs a human subject doing something. No passive constructions. No inanimate objects performing human actions ("the complaint becomes a fix").

4. **Be specific.** No vague declaratives ("The reasons are structural"). Name the specific thing. No lazy extremes ("every," "always," "never") doing vague work.

5. **Put the reader in the room.** No narrator-from-a-distance voice. "You" beats "People." Specifics beat abstractions.

6. **Vary rhythm.** Mix sentence lengths. Two items beat three. End paragraphs differently. No em dashes.

7. **Trust readers.** State facts directly. Skip softening, justification, hand-holding.

8. **Cut quotables.** If it sounds like a pull-quote, rewrite it.

## Quick Checks

Before delivering prose:

- Any adverbs? Kill them.
- Any passive voice? Find the actor, make them the subject.
- Inanimate thing doing a human verb ("the decision emerges")? Name the person.
- Sentence starts with a Wh- word? Restructure it.
- Any "here's what/this/that" throat-clearing? Cut to the point.
- Any "not X, it's Y" contrasts? State Y directly.
- Three consecutive sentences match length? Break one.
- Paragraph ends with punchy one-liner? Vary it.
- Em-dash anywhere? Remove it.
- Vague declarative ("The implications are significant")? Name the specific implication.`;

/**
 * Approximation of the parent chat agent's system prompt — the eval
 * doesn't import the real prompt to keep the scenario hermetic, but
 * the shape (terse, generally helpful assistant) matches workspace-chat
 * closely enough that the Polish/non-Polish signal isn't dominated by
 * the system prompt's own instructions.
 */
const PARENT_SYSTEM_PROMPT =
  "You are a helpful assistant. You have access to a load_skill tool that lets " +
  "you load skill instructions during the conversation. When the user asks you to " +
  "write text, write it directly in your response. Be concise.";

/**
 * Literary contrast prompts — the model defaults to em-dashes for this
 * register. Each prompt asks for ~4 sentences so there are multiple
 * opportunities for the punctuation to leak. If the skill is landing
 * in the right slot, em-dashes drop to zero regardless.
 */
const TOPICS = [
  "Write a four-sentence literary paragraph contrasting industrial cheese with artisanal cheesemaking. Use evocative, sensory prose.",
  "Write a four-sentence literary paragraph contrasting chain coffee shops with independent third-wave roasters. Use evocative, sensory prose.",
  "Write a four-sentence literary paragraph contrasting mass-produced supermarket bread with a sourdough loaf from a small bakery. Use evocative, sensory prose.",
];

interface AnthropicContentBlock {
  type: string;
  [k: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

async function callAnthropic(opts: {
  system: string;
  messages: AnthropicMessage[];
}): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      temperature: 0,
      system: opts.system,
      messages: opts.messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
    .map((b) => b.text)
    .join("");
}

/**
 * Build the load_skill tool-result block the AI SDK would emit. Mirrors
 * `packages/skills/src/load-skill-tool.ts` execute() return shape.
 */
function loadSkillToolResult(): AnthropicContentBlock[] {
  return [
    {
      type: "tool_result",
      tool_use_id: "tu_load_skill",
      content: JSON.stringify({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        instructions: SKILL_INSTRUCTIONS,
      }),
    },
  ];
}

function loadSkillToolUse(): AnthropicContentBlock[] {
  return [
    { type: "tool_use", id: "tu_load_skill", name: "load_skill", input: { name: SKILL_NAME } },
  ];
}

function systemReminderBlock(): string {
  return (
    "<system-reminder>\n" +
    `Active skill loaded for this conversation: ${SKILL_NAME}\n\n` +
    `${SKILL_INSTRUCTIONS}\n` +
    "</system-reminder>"
  );
}

/**
 * Variant A — current behavior. The skill body lives in a tool-result
 * content block. Subsequent user turns are plain text. This is what
 * `load_skill` produces today.
 */
async function runVariantA(turn: 1 | 3): Promise<string> {
  const messages: AnthropicMessage[] = [
    { role: "user", content: `Load the ${SKILL_NAME} skill via load_skill, then ${TOPICS[0]}` },
    { role: "assistant", content: loadSkillToolUse() },
    { role: "user", content: loadSkillToolResult() },
  ];

  if (turn === 1) {
    return await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  }

  // Multi-turn — get the model's first written response, then ask for
  // more on a different topic. The "forgetting" signal is whether the
  // skill's effect persists across turns without re-injection.
  const turn1 = await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  messages.push({ role: "assistant", content: turn1 });
  messages.push({ role: "user", content: TOPICS[1]! });
  const turn2 = await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  messages.push({ role: "assistant", content: turn2 });
  messages.push({ role: "user", content: TOPICS[2]! });
  return await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
}

/**
 * Variant B — proposed fix. Same flow as A, but every subsequent user
 * turn carries a `<system-reminder>` block re-injecting the loaded
 * skill body. This is what an "after-load_skill, sticky system slot"
 * implementation would produce.
 */
async function runVariantB(turn: 1 | 3): Promise<string> {
  const reminder = systemReminderBlock();
  const messages: AnthropicMessage[] = [
    { role: "user", content: `Load the ${SKILL_NAME} skill via load_skill, then ${TOPICS[0]}` },
    { role: "assistant", content: loadSkillToolUse() },
    {
      role: "user",
      content: [
        ...loadSkillToolResult(),
        // Anthropic accepts mixed content blocks in a user message.
        // The reminder lands as a text block alongside the tool_result.
        { type: "text", text: reminder },
      ],
    },
  ];

  if (turn === 1) {
    return await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  }

  const turn1 = await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  messages.push({ role: "assistant", content: turn1 });
  messages.push({ role: "user", content: `${reminder}\n\n${TOPICS[1]}` });
  const turn2 = await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
  messages.push({ role: "assistant", content: turn2 });
  messages.push({ role: "user", content: `${reminder}\n\n${TOPICS[2]}` });
  return await callAnthropic({ system: PARENT_SYSTEM_PROMPT, messages });
}

async function runEval(): Promise<EvalResult[]> {
  console.log("  → A turn 1 (tool-result only)");
  const aT1 = await runVariantA(1);
  console.log("  → A turn 3 (tool-result only, persistence)");
  const aT3 = await runVariantA(3);
  console.log("  → B turn 1 (tool-result + system-reminder)");
  const bT1 = await runVariantB(1);
  console.log("  → B turn 3 (tool-result + system-reminder, persistence)");
  const bT3 = await runVariantB(3);

  const aT1Em = countEmDashes(aT1);
  const aT3Em = countEmDashes(aT3);
  const bT1Em = countEmDashes(bT1);
  const bT3Em = countEmDashes(bT3);

  const results: EvalResult[] = [];

  // Variant B should produce zero em-dashes at both turn 1 and turn 3.
  results.push({
    id: "load-skill-injection-B-turn1-no-em-dashes",
    pass: bT1Em === 0,
    notes: [`B turn 1 (system-reminder, immediate): ${bT1.slice(0, 200)}`, `em-dashes: ${bT1Em}`],
    metrics: { emDashes: bT1Em, length: bT1.length },
  });

  results.push({
    id: "load-skill-injection-B-turn3-no-em-dashes",
    pass: bT3Em === 0,
    notes: [`B turn 3 (system-reminder, persistence): ${bT3.slice(0, 200)}`, `em-dashes: ${bT3Em}`],
    metrics: { emDashes: bT3Em, length: bT3.length },
  });

  // Causal: B's em-dash count must be ≤ A's on every turn — never
  // worse. Strict-greater is the strong evidence; equal is acceptable
  // when the model happens to comply from tool-result alone (rare with
  // a buried rule but possible). The previous turn1 / turn3 strict
  // tests already gate B==0; this one rules out B regressing past A.
  const noRegression = bT1Em <= aT1Em && bT3Em <= aT3Em;
  results.push({
    id: "load-skill-injection-B-no-worse-than-A",
    pass: noRegression,
    notes: [
      `A em-dashes: turn1=${aT1Em} turn3=${aT3Em}`,
      `B em-dashes: turn1=${bT1Em} turn3=${bT3Em}`,
      "Pass requires B em-dashes ≤ A em-dashes on every turn.",
    ],
    metrics: { aT1Em, aT3Em, bT1Em, bT3Em },
  });

  // Documentation case — always passes. Records A's behavior so a
  // future model that suddenly honors tool-result skills becomes
  // visible (the A em-dash counts would drop to zero).
  results.push({
    id: "load-skill-injection-A-baseline",
    pass: true,
    notes: [
      `A turn 1 (control): ${aT1.slice(0, 200)}`,
      `A turn 3 (control): ${aT3.slice(0, 200)}`,
      `A em-dashes: turn1=${aT1Em} turn3=${aT3Em}`,
    ],
    metrics: { aT1Em, aT3Em },
  });

  return results;
}

async function main() {
  await ensureCredentialsLoaded();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY required — set it in ~/.atlas/.env or env.");
    Deno.exit(2);
  }

  const args = Deno.args;
  const jsonOutputIdx = args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputIdx >= 0 ? args[jsonOutputIdx + 1] : undefined;
  const writeResult = args.includes("--write");

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`▶ load-skill-injection eval @ ${sha}`);

  const results = await runEval();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ load-skill-injection summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const path =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-load-skill-injection.json`);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
