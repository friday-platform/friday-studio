#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * Combined static eval for Phases 6, 7, 8 of the system-skills remodel.
 *
 * Phase 6: debug catalog + diagnostic discipline directive.
 * Phase 7: agent-action-handshake skill.
 * Phase 8: delegate-handoff skill + delegation_with_skills directive.
 *
 * Asserts:
 *   1. All 7 new SKILL.md files exist with the right `name:` frontmatter.
 *   2. Each description carries its trigger keywords.
 *   3. Each skill cross-references at least one sibling.
 *   4. The chat-agent prompt has `<diagnostic_load>`,
 *      `<runtime_bug_discipline>`, and `<delegation_with_skills>` blocks.
 *   5. Each directive contains the load-bearing phrasing.
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

const SKILLS_DIR = join(ROOT, "packages/system/skills");
const CHAT_PROMPT = join(ROOT, "packages/system/agents/workspace-chat/prompt.txt");

interface SkillCheck {
  id: string;
  dir: string;
  expectedName: string;
  triggerKeywords: string[];
  crossRefs: string[];
}

const SKILL_CHECKS: SkillCheck[] = [
  {
    id: "skill-debugging-broken-jobs",
    dir: "debugging-broken-jobs",
    expectedName: "debugging-broken-jobs",
    triggerKeywords: ["output-error", 'summary: ""', "platform bug"],
    crossRefs: ["debugging-empty-output", "debugging-runtime-errors"],
  },
  {
    id: "skill-debugging-empty-output",
    dir: "debugging-empty-output",
    expectedName: "debugging-empty-output",
    triggerKeywords: ["status: completed", 'summary: ""', "complete()"],
    crossRefs: ["agent-action-handshake", "debugging-broken-jobs"],
  },
  {
    id: "skill-debugging-tool-loops",
    dir: "debugging-tool-loops",
    expectedName: "debugging-tool-loops",
    triggerKeywords: ["tool calls", "stepCountIs", "no terminal text"],
    crossRefs: ["debugging-broken-jobs", "agent-action-handshake"],
  },
  {
    id: "skill-debugging-runtime-errors",
    dir: "debugging-runtime-errors",
    expectedName: "debugging-runtime-errors",
    triggerKeywords: ["did not call complete", "Invalid job config", "Invalid signal config"],
    crossRefs: ["agent-action-handshake", "debugging-broken-jobs"],
  },
  {
    id: "skill-debugging-job-invocation",
    dir: "debugging-job-invocation",
    expectedName: "debugging-job-invocation",
    triggerKeywords: ["output-error", "Pattern A", "Pattern B"],
    crossRefs: ["debugging-empty-output", "debugging-broken-jobs"],
  },
  {
    id: "skill-agent-action-handshake",
    dir: "agent-action-handshake",
    expectedName: "agent-action-handshake",
    triggerKeywords: ["outputTo", "complete", "auto-injects"],
    crossRefs: ["delegate-handoff", "debugging-empty-output"],
  },
  {
    id: "skill-delegate-handoff",
    dir: "delegate-handoff",
    expectedName: "delegate-handoff",
    triggerKeywords: ["delegate(", "load_skill", "skills:"],
    crossRefs: ["agent-action-handshake", "using-mcp-servers"],
  },
];

interface DirectiveCheck {
  id: string;
  blockName: string;
  loadBearingPhrases: string[];
}

const DIRECTIVE_CHECKS: DirectiveCheck[] = [
  {
    id: "prompt-directive-diagnostic-load",
    blockName: "diagnostic_load",
    loadBearingPhrases: [
      "BEFORE forming a hypothesis",
      "did not call complete",
      "@friday/debugging-empty-output",
      "@friday/debugging-runtime-errors",
      "@friday/debugging-job-invocation",
      "@friday/debugging-tool-loops",
      "@friday/debugging-broken-jobs",
    ],
  },
  {
    id: "prompt-directive-runtime-bug-discipline",
    blockName: "runtime_bug_discipline",
    loadBearingPhrases: [
      "may NOT claim",
      "platform bug",
      "describe_session",
      "agentBlocks[].toolCalls",
      "contracted exit",
    ],
  },
  {
    id: "prompt-directive-delegation-with-skills",
    blockName: "delegation_with_skills",
    loadBearingPhrases: [
      "NO `<available_skills>`",
      "NO `load_skill`",
      "skills:",
      "Always pass `skills`",
      "@friday/delegate-handoff",
    ],
  },
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function checkSkill(c: SkillCheck): Promise<EvalResult> {
  const skillFile = join(SKILLS_DIR, c.dir, "SKILL.md");
  if (!(await pathExists(skillFile))) {
    return {
      id: c.id,
      pass: false,
      notes: [`SKILL.md not found at ${skillFile}`],
      metrics: { dir: c.dir },
    };
  }
  const text = await Deno.readTextFile(skillFile);
  const notes: string[] = [];
  let pass = true;

  if (!text.includes(`name: ${c.expectedName}`)) {
    pass = false;
    notes.push(`frontmatter name: missing or mismatched (expected ${c.expectedName})`);
  }
  for (const kw of c.triggerKeywords) {
    if (!text.includes(kw)) {
      pass = false;
      notes.push(`trigger keyword missing: ${JSON.stringify(kw)}`);
    }
  }
  for (const ref of c.crossRefs) {
    if (!text.includes(ref)) {
      pass = false;
      notes.push(`cross-reference missing: ${ref}`);
    }
  }
  if (pass) notes.push(`all assertions passed`);

  return {
    id: c.id,
    pass,
    notes,
    metrics: { dir: c.dir, bytes: text.length, lines: text.split("\n").length },
  };
}

async function checkDirective(c: DirectiveCheck): Promise<EvalResult> {
  const text = await Deno.readTextFile(CHAT_PROMPT);
  const open = `<${c.blockName}>`;
  const close = `</${c.blockName}>`;
  const notes: string[] = [];
  let pass = true;

  if (!text.includes(open) || !text.includes(close)) {
    pass = false;
    notes.push(`directive block <${c.blockName}> not found in prompt`);
    return { id: c.id, pass, notes, metrics: { blockName: c.blockName } };
  }
  const startIdx = text.indexOf(open);
  const endIdx = text.indexOf(close);
  const body = text.slice(startIdx, endIdx + close.length);

  for (const phrase of c.loadBearingPhrases) {
    if (!body.includes(phrase)) {
      pass = false;
      notes.push(`load-bearing phrase missing inside <${c.blockName}>: ${JSON.stringify(phrase)}`);
    }
  }
  if (pass) notes.push(`all assertions passed`);

  return { id: c.id, pass, notes, metrics: { blockName: c.blockName, bodyLength: body.length } };
}

const args = Object.fromEntries(
  Deno.args
    .map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : null))
    .filter((x): x is [string, string | true] => x !== null),
);
const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : null;

const sha = await currentGitSha();
const startedAt = new Date().toISOString();
const skillResults = await Promise.all(SKILL_CHECKS.map(checkSkill));
const directiveResults = await Promise.all(DIRECTIVE_CHECKS.map(checkDirective));
const results = [...skillResults, ...directiveResults];
const finishedAt = new Date().toISOString();

const report = { id: "skill-catalog-and-directives", sha, startedAt, finishedAt, results };

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
