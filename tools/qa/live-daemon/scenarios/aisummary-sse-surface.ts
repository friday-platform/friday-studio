#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * Phase 2 eval — `buildSessionJobResult` never returns an empty `summary`.
 *
 * Static text check on `packages/workspace/src/runtime.ts` instead of a
 * function call: importing runtime.ts pulls a heavy transitive closure
 * (oauth, platform tools, MCP) that's unsuitable for a pure-function eval.
 *
 * Asserts:
 *   1. `EMPTY_SESSION_SUMMARY` constant exists.
 *   2. `nonEmptySummary` wrapper exists.
 *   3. Each `synthesizeFallbackSummary(...)` and `synthesizeArtifactSummary(...)`
 *      callsite inside `buildSessionJobResult` is wrapped by `nonEmptySummary`.
 *   4. Constant text contains a useful diagnostic prose tag.
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

const RUNTIME_PATH = join(ROOT, "packages/workspace/src/runtime.ts");

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

const text = await readText(RUNTIME_PATH);

interface Check {
  id: string;
  description: string;
  pass: boolean;
  notes: string[];
}

const checks: Check[] = [];

// 1. constant exists
{
  const has = text.includes("const EMPTY_SESSION_SUMMARY");
  checks.push({
    id: "empty-session-summary-constant-defined",
    description: "EMPTY_SESSION_SUMMARY const exists",
    pass: has,
    notes: has ? ["found"] : ["EMPTY_SESSION_SUMMARY constant not defined in runtime.ts"],
  });
}

// 2. wrapper exists
{
  const has = text.includes("function nonEmptySummary");
  checks.push({
    id: "non-empty-summary-wrapper-defined",
    description: "nonEmptySummary wrapper function exists",
    pass: has,
    notes: has ? ["found"] : ["nonEmptySummary function not defined"],
  });
}

// 3. wrapper used in each fallback site within buildSessionJobResult
{
  // Anchor: split runtime.ts on the export function declaration; the body
  // is everything between buildSessionJobResult start and the next blank-
  // line + `export ` boundary (matches the codebase's formatting).
  const fnIdx = text.indexOf("export function buildSessionJobResult(");
  if (fnIdx < 0) {
    checks.push({
      id: "build-session-job-result-uses-non-empty-summary",
      description: "buildSessionJobResult function exists",
      pass: false,
      notes: ["buildSessionJobResult not found in runtime.ts"],
    });
  } else {
    const after = text.slice(fnIdx);
    // Take up to the closing `\n}\n` of the outer function — the file's
    // formatter places top-level closes on their own line so this anchor
    // is reliable.
    const closeIdx = after.indexOf("\n}\n");
    const body = closeIdx > 0 ? after.slice(0, closeIdx + 3) : after;
    const fallbackSites = (body.match(/synthesize(Fallback|Artifact)Summary\(/g) ?? []).length;
    const wrappedSites = (
      body.match(/nonEmptySummary\(synthesize(Fallback|Artifact)Summary\(/g) ?? []
    ).length;
    const allWrapped = fallbackSites > 0 && wrappedSites === fallbackSites;
    checks.push({
      id: "build-session-job-result-uses-non-empty-summary",
      description: "Every synthesize* call inside buildSessionJobResult is wrapped",
      pass: allWrapped,
      notes: [`fallback sites: ${fallbackSites}, wrapped: ${wrappedSites}`],
    });
  }
}

// 4. constant carries diagnostic text
{
  const has = text.includes("did not call `complete()`") || text.includes("`outputTo` action");
  checks.push({
    id: "empty-session-summary-prose-useful",
    description: "EMPTY_SESSION_SUMMARY contains useful diagnostic prose",
    pass: has,
    notes: has
      ? ["sentinel mentions complete() / outputTo"]
      : ["sentinel text doesn't mention complete() or outputTo — refactor or update assertion"],
  });
}

const results: EvalResult[] = checks.map((c) => ({
  id: c.id,
  pass: c.pass,
  notes: c.notes,
  metrics: { description: c.description },
}));

const args = Object.fromEntries(
  Deno.args
    .map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : null))
    .filter((x): x is [string, string | true] => x !== null),
);
const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : null;

const sha = await currentGitSha();
const startedAt = new Date().toISOString();
const finishedAt = startedAt;

const report = { id: "aisummary-sse-surface", sha, startedAt, finishedAt, results };

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
