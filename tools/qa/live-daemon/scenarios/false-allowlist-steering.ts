#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * Static-text eval for Phase 3 of the system-skills remodel.
 *
 * Asserts that ambient steering across prompt + skill + tool description
 * surfaces no longer claims `config.tools` is the complete tool surface, that
 * `tools: []` produces only memory + artifacts, or that atlas agents are
 * tool-isolated. Each of these claims contradicts the runtime's auto-injection
 * (PLATFORM_TOOL_NAMES in packages/agent-sdk/src/platform-tools.ts).
 *
 * Static rather than live-LLM because the diagnosis is a text check: the
 * corrected sentences must be present and the false sentences must be absent.
 * An LLM eval that asks the agent "can my type:llm agent call create_artifact?"
 * is reserved for Phase 6's debug-empty-output gate, where the agent is
 * exercising the debug skill, not the prompt directly.
 *
 * Causal pair logic still applies: each test has a "false claim" assertion
 * (must NOT match) and a "corrected claim" assertion (must match). On `main`
 * the false claims pass (so the test fails); after Phase 3 patches the false
 * claims fail (so the test passes).
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

const FILES = {
  workspaceChatPrompt: join(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  writingWorkspaceJobs: join(ROOT, "packages/system/skills/writing-workspace-jobs/SKILL.md"),
  workspaceApi: join(ROOT, "packages/system/skills/workspace-api/SKILL.md"),
  upsertTools: join(ROOT, "packages/system/agents/workspace-chat/tools/upsert-tools.ts"),
  platformTools: join(ROOT, "packages/agent-sdk/src/platform-tools.ts"),
};

interface TextCase {
  id: string;
  file: string;
  /** Substrings that MUST NOT appear in the file (false claims). */
  forbidden: string[];
  /** Substrings that MUST appear in the file (corrected claims). */
  required: string[];
}

const CASES: TextCase[] = [
  {
    id: "workspace-chat-prompt-tools-allowlist",
    file: FILES.workspaceChatPrompt,
    forbidden: [
      // The exact misleading sentence on prompt:115.
      "the agent will only see those",
    ],
    required: [
      // Corrected wording must explicitly call out platform-tool auto-injection.
      "platform tools",
      "auto-inject",
    ],
  },
  {
    id: "writing-workspace-jobs-empty-tools-misclaim",
    file: FILES.writingWorkspaceJobs,
    forbidden: [
      // The misleading line at :634.
      "no MCP/platform tools available; only the",
      "auto-injected built-ins (memory + artifacts; see below)",
    ],
    required: [
      // Corrected description: empty tools array means no MCP, but the FULL platform set still injects.
      "no MCP server tools",
      "platform tools still inject",
    ],
  },
  {
    id: "writing-workspace-jobs-stale-tool-names",
    file: FILES.writingWorkspaceJobs,
    forbidden: [
      // Stale post-rename names that should not appear. Verified against
      // PLATFORM_TOOL_NAMES in packages/agent-sdk/src/platform-tools.ts:
      // `artifacts_update`, `artifacts_delete`, `artifacts_get_by_chat`
      // are CURRENT names (the rename only touched create/get; the rest
      // retain their original prefix). `memory_save`, `memory_read`,
      // `memory_remove`, `artifacts_create`, `artifacts_get`,
      // `get_mcp_dependencies` were all renamed and must be excised.
      "memory_save",
      "memory_read",
      "memory_remove",
      "artifacts_create",
      "artifacts_get`", // backtick-bound; bare `artifacts_get_by_chat` is fine
      "get_mcp_dependencies",
    ],
    required: [],
  },
  {
    id: "workspace-api-platform-tools-clarity",
    file: FILES.workspaceApi,
    forbidden: [
      // Stale tool names.
      "memory_save",
      "artifacts_create",
      "artifacts_get`", // bare `artifacts_get_by_chat` is fine
    ],
    required: [
      // The atlas-agent description must clarify platform tools still apply.
      "platform tools",
    ],
  },
  {
    id: "upsert-tools-atlas-agent-clarity",
    file: FILES.upsertTools,
    forbidden: [
      // The misleading "self-contained black box" framing without the
      // platform-tool clarification.
    ],
    required: [
      // The corrected description must mention platform tools still inject for atlas.
      "platform tools",
    ],
  },
];

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function runOne(c: TextCase): Promise<EvalResult> {
  const text = await readText(c.file);
  const notes: string[] = [];

  let pass = true;
  for (const f of c.forbidden) {
    if (text.includes(f)) {
      pass = false;
      notes.push(`FORBIDDEN substring still present: ${JSON.stringify(f)}`);
    }
  }
  for (const r of c.required) {
    if (!text.includes(r)) {
      pass = false;
      notes.push(`REQUIRED substring missing: ${JSON.stringify(r)}`);
    }
  }
  if (pass) notes.push(`all assertions passed for ${c.file}`);

  return {
    id: c.id,
    pass,
    notes,
    metrics: {
      file: c.file,
      forbiddenChecked: c.forbidden.length,
      requiredChecked: c.required.length,
      bytes: text.length,
    },
  };
}

async function runEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of CASES) {
    try {
      results.push(await runOne(c));
    } catch (err) {
      results.push({
        id: c.id,
        pass: false,
        notes: [`runner error: ${err instanceof Error ? err.message : String(err)}`],
        metrics: { file: c.file },
      });
    }
  }
  return results;
}

const args = Object.fromEntries(
  Deno.args
    .map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : null))
    .filter((x): x is [string, string | true] => x !== null),
);
const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : null;

const sha = await currentGitSha();
const startedAt = new Date().toISOString();
const results = await runEval();
const finishedAt = new Date().toISOString();

const report = { id: "false-allowlist-steering", sha, startedAt, finishedAt, results };

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

if (passCount !== results.length) {
  Deno.exit(1);
}
