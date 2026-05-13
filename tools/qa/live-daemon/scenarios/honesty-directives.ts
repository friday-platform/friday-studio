#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * Honesty + destructive-tool guard directive presence eval.
 *
 * Workspace-chat already has chat-flavor honesty in `<outcome_quality>`,
 * `<honesty>`, and `<investigate_before_answering>` — but a real-world
 * trajectory still produced a `send_gmail_message({to:
 * "ljagiello@zmail.com"})` call where the address was invented.
 * The directives the chat agent had cover output-prose fabrication;
 * they don't cover destructive-tool argument fabrication, which is
 * worse (the world acts on the invented value, not just the user
 * reading text).
 *
 * Two directives ship from `packages/core/src/agent-context/honesty-
 * directives.ts`:
 *   - `AGENT_HONESTY_DIRECTIVE` (Layer A) — sourcing rule for output
 *     prose. Inject into surfaces that don't already have a
 *     chat-flavor equivalent.
 *   - `DESTRUCTIVE_TOOL_GUARD` (Layer B) — pre-flight check on tool
 *     args for write/send/delete tools. Inject everywhere a write
 *     tool can be invoked.
 *
 * Surface plan (matches the proposal in the chat that landed this):
 *
 *   surface                        | Layer A | Layer B
 *   -------------------------------|---------|--------
 *   workspace-chat (prompt.txt)    | already | NEW
 *   from-llm.ts (case "agent"→llm) | NEW     | NEW
 *   fsm-engine.ts (case "llm")     | NEW     | NEW
 *   delegate/system-prompt.ts      | NEW     | NEW
 *   session-supervisor/prompts.ts  | NEW     | n/a (no tools)
 *
 * Each block has a sentinel substring this eval pins. Layer A's
 * sentinel: "HONESTY:". Layer B's sentinel: "DESTRUCTIVE-TOOL GUARD:".
 * Static check — if either string is missing from a call site that
 * was supposed to inject it, the eval fails. Doesn't probe model
 * behavior; that would need a fabrication-attempt scenario which is
 * an order of magnitude more expensive and is reserved for a
 * follow-up if real-world drift surfaces.
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import { currentGitSha } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const ROOT = (() => {
  const here = new URL(".", import.meta.url).pathname;
  return new URL("../../../..", `file://${here}`).pathname;
})();

const HONESTY_SENTINEL = "HONESTY:";
const GUARD_SENTINEL = "DESTRUCTIVE-TOOL GUARD:";

interface FileCheck {
  id: string;
  file: string;
  /** Sentinels that MUST appear somewhere in the file. */
  required: string[];
  /** Substrings that MUST NOT appear (e.g. duplicate injection). */
  forbidden?: string[];
}

const FILE_CHECKS: FileCheck[] = [
  {
    // The shared module exports both blocks. Source of truth.
    id: "honesty-directives-module-exists",
    file: join(ROOT, "packages/core/src/agent-context/honesty-directives.ts"),
    required: [
      "export const AGENT_HONESTY_DIRECTIVE",
      "export const DESTRUCTIVE_TOOL_GUARD",
      HONESTY_SENTINEL,
      GUARD_SENTINEL,
    ],
  },
  {
    // Workspace-chat: Layer B inlined into the prompt (chat is
    // authored, not generated, so we don't import).
    id: "workspace-chat-prompt-has-destructive-tool-guard",
    file: join(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
    required: [GUARD_SENTINEL, "destructive_tool_guard"],
    // Layer A would duplicate the existing `<honesty>` block — assert
    // we did NOT inject it.
    forbidden: [HONESTY_SENTINEL],
  },
  {
    // FSM `case "agent"` → llm runner: both directives appended.
    id: "from-llm-injects-both-directives",
    file: join(ROOT, "packages/core/src/agent-conversion/from-llm.ts"),
    required: ["AGENT_HONESTY_DIRECTIVE", "DESTRUCTIVE_TOOL_GUARD", "honesty-directives"],
  },
  {
    // FSM `case "llm"` inline action: both directives appended
    // alongside the existing complete/failStep instructions.
    id: "fsm-engine-injects-both-directives",
    file: join(ROOT, "packages/fsm-engine/fsm-engine.ts"),
    required: ["AGENT_HONESTY_DIRECTIVE", "DESTRUCTIVE_TOOL_GUARD", "honesty-directives"],
  },
  {
    // Delegate sub-agent system prompt: both directives inlined into
    // the existing system-prompt builder alongside scope + MCP-error.
    id: "delegate-system-prompt-injects-both-directives",
    file: join(ROOT, "packages/core/src/delegate/system-prompt.ts"),
    required: ["AGENT_HONESTY_DIRECTIVE", "DESTRUCTIVE_TOOL_GUARD"],
  },
  {
    // Session supervisor: Layer A only (no tools, no destructive
    // ops). The directive flows in via `${AGENT_HONESTY_DIRECTIVE}`
    // template-literal expansion, so the source text checks for the
    // import + the constant reference rather than the sentinel
    // string itself (which only lives in honesty-directives.ts).
    id: "session-supervisor-injects-honesty-only",
    file: join(ROOT, "packages/system/agents/session-supervisor/prompts.ts"),
    required: ["AGENT_HONESTY_DIRECTIVE", "honesty-directives"],
    // Supervisor has no tools — guarding it would be ceremony.
    forbidden: ["DESTRUCTIVE_TOOL_GUARD", GUARD_SENTINEL],
  },
];

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function runOne(c: FileCheck): Promise<EvalResult> {
  let text: string;
  try {
    text = await readText(c.file);
  } catch (err) {
    return {
      id: c.id,
      pass: false,
      notes: [`could not read ${c.file}: ${err instanceof Error ? err.message : String(err)}`],
      metrics: { file: c.file },
    };
  }
  const notes: string[] = [];
  let pass = true;
  for (const r of c.required) {
    if (!text.includes(r)) {
      pass = false;
      notes.push(`REQUIRED substring missing: ${JSON.stringify(r)}`);
    }
  }
  for (const f of c.forbidden ?? []) {
    if (text.includes(f)) {
      pass = false;
      notes.push(`FORBIDDEN substring present: ${JSON.stringify(f)}`);
    }
  }
  if (pass) notes.push(`all assertions passed for ${c.file}`);
  return {
    id: c.id,
    pass,
    notes,
    metrics: {
      file: c.file,
      requiredChecked: c.required.length,
      forbiddenChecked: c.forbidden?.length ?? 0,
    },
  };
}

const args = Object.fromEntries(
  Deno.args
    .map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : null))
    .filter((x): x is [string, string | true] => x !== null),
);
const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : null;

const sha = await currentGitSha();
const startedAt = new Date().toISOString();
const results: EvalResult[] = [];
for (const c of FILE_CHECKS) results.push(await runOne(c));
const finishedAt = new Date().toISOString();

const report = { id: "honesty-directives", sha, startedAt, finishedAt, results };

if (jsonOutput) {
  await ensureDir(dirname(jsonOutput));
  await Deno.writeTextFile(jsonOutput, JSON.stringify(report, null, 2));
  console.log(`wrote report to ${jsonOutput}`);
}

const passCount = results.filter((r) => r.pass).length;
console.log(`\n${passCount}/${results.length} cases passed (sha=${sha})`);
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.id}`);
  if (!r.pass) for (const n of r.notes) console.log(`    - ${n}`);
}

if (passCount !== results.length) Deno.exit(1);
