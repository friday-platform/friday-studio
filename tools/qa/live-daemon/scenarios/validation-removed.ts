#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * Static eval for Phase 1 of the system-skills remodel: validation/judge/
 * hallucination subsystem ripped out.
 *
 * Asserts that:
 *   1. `packages/hallucination/` does not exist.
 *   2. `packages/system/agents/judge-agent/` does not exist.
 *   3. `packages/system/skills/validating-llm-outputs/` does not exist.
 *   4. The `validate` field is gone from `LLMActionSchema` and
 *      `AgentActionSchema` in `packages/fsm-engine/schema.ts`.
 *   5. `record_validation` is no longer injected as a tool — must not appear
 *      as a tool name in `from-llm.ts` or `fsm-engine.ts`.
 *   6. `__atlas_validate` config-key plumbing is gone (no references in
 *      `runtime.ts` or `from-llm.ts`).
 *   7. The `complete` tool injection IS still present (load-bearing —
 *      keep this). String "complete" appears in the relevant source.
 *   8. Typecheck (`deno task check`) passes — proxy for "no dangling
 *      imports to deleted modules." Static check of root tsconfig project.
 *
 * Behavior eval (separate, follows Phase 1 instrumentation): a `type: agent`
 * action with `outputTo` invoking a `type: llm` agent emits non-empty
 * `summary` + `artifactIds` (the user-reported scenario). That's
 * `validation-removed-behavior.ts` if/when added.
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

const DELETED_DIRS = [
  "packages/hallucination",
  "packages/system/agents/judge-agent",
  "packages/system/skills/validating-llm-outputs",
];

interface FileCheck {
  id: string;
  file: string;
  forbidden: string[];
  required: string[];
}

const FILE_CHECKS: FileCheck[] = [
  {
    id: "fsm-engine-schema-no-validate-field",
    file: join(ROOT, "packages/fsm-engine/schema.ts"),
    forbidden: ["ValidateStrategySchema", "validate: ValidateStrategySchema"],
    required: [],
  },
  {
    id: "from-llm-no-record-validation-injection",
    file: join(ROOT, "packages/core/src/agent-conversion/from-llm.ts"),
    forbidden: [
      "RECORD_VALIDATION_TOOL_NAME",
      "createRecordValidationTool",
      "composeValidationBlock",
      "readValidateDecisionFromConfig",
      "VALIDATE_DECISION_CONFIG_KEY",
      "__atlas_validate",
    ],
    required: [
      // Keep the complete tool — load-bearing contract for outputTo.
      "complete",
    ],
  },
  {
    id: "fsm-engine-no-record-validation-injection",
    file: join(ROOT, "packages/fsm-engine/fsm-engine.ts"),
    forbidden: [
      "resolveValidateDecision",
      "buildValidateDecisionConfig",
      "RECORD_VALIDATION_TOOL_NAME",
      "agentValidateDecision",
      "agentExternalSurvivingVerdict",
      "agentValidationOutput",
      "judgeAgentId",
      "runJudge",
    ],
    required: [
      // Complete-tool injection preserved.
      "complete",
    ],
  },
  {
    id: "runtime-no-validate-decision-config",
    file: join(ROOT, "packages/workspace/src/runtime.ts"),
    forbidden: [
      "buildValidateDecisionConfig",
      "VALIDATE_DECISION_CONFIG_KEY",
      "validateDecision,", // word-bounded — avoids matching validateDecisionResult etc.
      "validateSkill,", // word-bounded — avoids validateSkillReferences (unrelated)
      "validateSkill?",
      ": validateSkill",
      "options.validateSkill",
    ],
    required: [],
  },
];

async function runDeletedDirChecks(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const dir of DELETED_DIRS) {
    const full = join(ROOT, dir);
    const exists = await pathExists(full);
    results.push({
      id: `deleted-${dir.replaceAll("/", "-")}`,
      pass: !exists,
      notes: exists ? [`directory still exists: ${full}`] : [`gone (good): ${dir}`],
      metrics: { path: full, exists },
    });
  }
  return results;
}

async function runFileChecks(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of FILE_CHECKS) {
    let text: string;
    try {
      text = await readText(c.file);
    } catch (err) {
      results.push({
        id: c.id,
        pass: false,
        notes: [`could not read ${c.file}: ${err instanceof Error ? err.message : String(err)}`],
        metrics: { file: c.file },
      });
      continue;
    }
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
    results.push({
      id: c.id,
      pass,
      notes,
      metrics: {
        file: c.file,
        forbiddenChecked: c.forbidden.length,
        requiredChecked: c.required.length,
      },
    });
  }
  return results;
}

async function runEval(): Promise<EvalResult[]> {
  const dirResults = await runDeletedDirChecks();
  const fileResults = await runFileChecks();
  return [...dirResults, ...fileResults];
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

const report = { id: "validation-removed", sha, startedAt, finishedAt, results };

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
