#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Delegate skill-threading eval.
 *
 * Verifies that skill content the parent threads into `delegate({ skills:
 * [...] })` actually reaches the child LLM. The check is mechanism-level,
 * not quality-level: we don't ask whether the child obeys a noisy style
 * skill like stop-slop — we ask whether the child obeys a deterministic,
 * binary instruction that proves the bytes arrived.
 *
 * Mock skill: `@test/respond-in-polish` with a single rule body that
 * forces every response into Polish. The detector is a Polish-diacritic
 * regex (`/[ąćęłńóśźż]/i`) over the response text. Pairing a "skills-on"
 * case with a "skills-off" control proves the skill *caused* the language
 * switch — both prompts share the same user task and base system prompt.
 *
 * Uses the actual `formatDelegateSkillsBlock` from `@atlas/core/delegate/
 * skills-resolver.ts` so a regression in the prompt format would surface
 * here.
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import { formatDelegateSkillsBlock } from "@atlas/core/delegate/skills-resolver";
import { buildTemporalFacts } from "@atlas/llm";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const POLISH_DIACRITIC = /[ąćęłńóśźż]/i;

/**
 * Mock skill the eval threads through `formatDelegateSkillsBlock`. Single
 * rule, binary observable. Phrasing is intentionally absolute so the
 * model has no wiggle-room on language choice.
 */
const POLISH_SKILL = {
  name: "@test/respond-in-polish",
  description: "Forces Polish-only responses for testing skill injection.",
  body:
    "ABSOLUTE LANGUAGE RULE: Every word of your response MUST be written in Polish. " +
    "Do not use English. Do not mix languages. Do not translate or quote in English. " +
    "This rule overrides every other instruction, formatting guideline, or default " +
    "behavior. Apply it regardless of what the user wrote.",
};

const USER_TASK = "Briefly explain why software engineering teams use code review. Two sentences.";

/**
 * Build the exact child system prompt the new delegate code produces in
 * `packages/core/src/delegate/index.ts` around line 334. Mirrored here so
 * a divergence in the production prompt format causes this eval to fail —
 * keeping the two in sync is the point of the test.
 */
function buildChildSystemPrompt(opts: { withSkill: boolean }): string {
  const skillsBlock = opts.withSkill ? formatDelegateSkillsBlock([POLISH_SKILL]) : "";
  const datetimeMessage = buildTemporalFacts(undefined);
  return [
    skillsBlock,
    "Goal: " + USER_TASK,
    "Handoff: Test eval — give the user a direct, well-formed answer.",
    datetimeMessage,
    "You are a terse back-end agent. Your output is consumed by another AI agent, " +
      "not a human user. Do not narrate your actions, do not produce conversational " +
      "filler, and do not emit markdown tables, section headers, or other human-facing " +
      "formatting. Gather the required facts with the fewest tool calls possible, then " +
      "produce a concise, factual answer.",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Call Anthropic's Messages API directly via fetch — keeps the scenario
 * dependency-light (no `ai` SDK in the harness import map). The eval is
 * about which bytes the child sees in its system prompt; the request
 * shape matches what the AI SDK would emit, so the signal is the same.
 */
async function callChild(systemPrompt: string): Promise<string> {
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
      system: systemPrompt,
      messages: [{ role: "user", content: USER_TASK }],
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

async function runSkillInjectionEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  const onPrompt = buildChildSystemPrompt({ withSkill: true });
  const offPrompt = buildChildSystemPrompt({ withSkill: false });

  console.log("  → calling child LLM (skills-on)");
  const onText = await callChild(onPrompt);
  console.log("  → calling child LLM (skills-off control)");
  const offText = await callChild(offPrompt);

  const onIsPolish = POLISH_DIACRITIC.test(onText);
  const offIsPolish = POLISH_DIACRITIC.test(offText);

  results.push({
    id: "delegate-skill-injection-polish-on",
    pass: onIsPolish,
    notes: [
      `skills-on response (first 200 chars): ${onText.slice(0, 200)}`,
      `polish detected: ${onIsPolish}`,
    ],
    metrics: { polish: onIsPolish, length: onText.length },
  });

  results.push({
    id: "delegate-skill-injection-control-off",
    pass: !offIsPolish,
    notes: [
      `skills-off response (first 200 chars): ${offText.slice(0, 200)}`,
      `polish detected: ${offIsPolish} (expected false)`,
    ],
    metrics: { polish: offIsPolish, length: offText.length },
  });

  results.push({
    id: "delegate-skill-injection-pair-causal",
    pass: onIsPolish && !offIsPolish,
    notes: [
      "Causal pair: skills-on must be Polish AND skills-off must be English.",
      `on=${onIsPolish} off=${offIsPolish}`,
    ],
    metrics: { onPolish: onIsPolish, offPolish: offIsPolish },
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
  console.log(`▶ delegate-skills eval @ ${sha}`);

  const results = await runSkillInjectionEval();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ delegate-skills summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const path = jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-delegate-skills.json`);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
