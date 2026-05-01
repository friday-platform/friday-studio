#!/usr/bin/env -S deno run --allow-all
/**
 * Workspace Pipeline CLI — headless harness for the planner graph pipeline.
 *
 * Usage:
 *   deno task sim "prompt"                     Full pipeline
 *   deno task sim "prompt" --stop-at=plan       Stop after blueprint generation
 *   deno task sim "prompt" --stop-at=fsm        Stop after FSM compilation
 *   deno task sim "prompt" --real               Execute with real MCP agents
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process, { argv, exit } from "node:process";
import { parseArgs } from "node:util";
import { logger as consoleLogger } from "@atlas/logger/console";
import {
  formatClarifications,
  formatCompilerWarnings,
  PipelineError,
  type CompiledFSMDefinition,
  type WorkspaceBlueprint,
} from "@atlas/workspace-builder";
import { runPipeline, type StopAt } from "./src/lib/server/lib/workspace/pipeline.ts";
import type { ExecutionReport } from "./src/lib/server/lib/workspace/run-fsm.ts";

// Proto CLI always runs in local dev mode — set LINK_DEV_MODE so credential
// resolution through Link works without FRIDAY_KEY.
if (!process.env.LINK_DEV_MODE) {
  process.env.LINK_DEV_MODE = "true";
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  args: argv.slice(2),
  options: {
    "stop-at": { type: "string" },
    real: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  console.log(`
Workspace Pipeline CLI

Usage:
  deno task sim "prompt"                     Run full pipeline (plan → compile → run)
  deno task sim "prompt" --stop-at=plan      Stop after blueprint generation
  deno task sim "prompt" --stop-at=fsm       Stop after FSM compilation
  deno task sim "prompt" --real              Execute with real MCP agents

Options:
  --stop-at        Stop at a pipeline phase: "plan" or "fsm" (default: run all)
  --real           Use real agents via direct MCP execution instead of mocks
  --help, -h       Show this help
`);
  exit(0);
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const RUNS_DIR = resolve(import.meta.dirname, "runs", "workspaces");

function ensureRunsDir(): void {
  if (!existsSync(RUNS_DIR)) {
    mkdirSync(RUNS_DIR, { recursive: true });
  }
}

function createRunDir(slug: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dirName = `${timestamp}-${slug}`;
  const dir = join(RUNS_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

const prompt = positionals[0];
if (!prompt) {
  console.error("Error: Provide a prompt.\n");
  console.error('Usage: deno task sim "analyze CSV data"');
  exit(1);
}

const stopAt = values["stop-at"] as StopAt;
if (stopAt !== undefined && stopAt !== "plan" && stopAt !== "fsm") {
  console.error(`Error: --stop-at must be "plan" or "fsm", got "${stopAt}"`);
  exit(1);
}

console.log(`\n--- Workspace Pipeline ---\n`);
console.log(`Prompt: "${prompt}"`);

const slug = slugify(prompt);
ensureRunsDir();
const runDir = createRunDir(slug);

writeFileSync(
  join(runDir, "input.json"),
  JSON.stringify(
    { prompt, flags: { stopAt, real: values.real }, timestamp: new Date().toISOString() },
    null,
    2,
  ),
);

try {
  const result = await runPipeline({ prompt, logger: consoleLogger, stopAt, real: values.real });

  // ── Print blueprint summary ───────────────────────────────────────────
  const plan = result.blueprint.blueprint;
  console.log(`\n  Workspace: ${plan.workspace.name}`);
  console.log(`  Signals:   ${plan.signals.map((s) => s.id).join(", ")}`);
  console.log(`  Agents:    ${plan.agents.map((a) => a.id).join(", ")}`);
  const resourceSlugs = (plan.resources ?? []).map((r) => r.slug);
  console.log(`  Resources: ${resourceSlugs.length > 0 ? resourceSlugs.join(", ") : "none"}`);
  console.log(`  Jobs:      ${plan.jobs.length}`);
  for (const job of plan.jobs) {
    console.log(
      `    ${job.id}: ${job.steps.length} steps, ${job.documentContracts.length} contracts, ${job.prepareMappings.length} mappings`,
    );
  }

  if (result.blueprint.clarifications.length > 0) {
    console.log(`\n${formatClarifications(result.blueprint.clarifications)}`);
  }

  if (!result.blueprint.readiness.ready) {
    const missingKeys = result.blueprint.readiness.checks
      .flatMap((c) => c.checks)
      .filter((c) => c.status === "missing")
      .map((c) => c.key);
    console.log(`\n  Missing credentials/env vars: ${missingKeys.join(", ")} (continuing anyway)`);
  }

  writeFileSync(join(runDir, "phase3.json"), JSON.stringify(plan, null, 2));

  // ── Print compilation summary ─────────────────────────────────────────
  if (result.compilation) {
    for (const fsm of result.compilation.fsms) {
      console.log(
        `  ${fsm.id}: ${Object.keys(fsm.states).length} states, ${Object.keys(fsm.functions ?? {}).length} functions`,
      );
    }

    const warningOutput = formatCompilerWarnings(result.compilation.warnings);
    if (warningOutput) {
      console.log(`\n${warningOutput}`);
    }

    writeFileSync(join(runDir, "fsm.json"), JSON.stringify(result.compilation.fsms, null, 2));
  }

  // ── Save workspace.yml ────────────────────────────────────────────────
  if (result.workspaceYaml) {
    writeFileSync(join(runDir, "workspace.yml"), result.workspaceYaml);
    console.log(`\nworkspace.yml generated`);
  }

  // ── Print execution summary ───────────────────────────────────────────
  if (result.execution) {
    for (const report of result.execution.reports) {
      const fsmId = result.compilation?.fsms.find(
        (_f, i) => result.execution?.reports[i] === report,
      )?.id;
      printExecutionSummary(fsmId ?? "unknown", report);
    }
    writeFileSync(
      join(runDir, "execution-report.json"),
      JSON.stringify(result.execution.reports, null, 2),
    );
  }

  writeSummary(runDir, plan, result.compilation?.fsms ?? [], result.workspaceYaml !== undefined);

  if (stopAt) {
    console.log(`\n--- Stopped at: ${stopAt} ---`);
  }

  console.log(`\nRun saved: ${runDir}`);
  exit(0);
} catch (error) {
  if (error instanceof PipelineError) {
    formatPipelineError(error);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nPipeline error: ${message}`);
  }

  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(join(runDir, "errors.json"), JSON.stringify({ error: message }, null, 2));

  const summaryPath = join(runDir, "summary.txt");
  if (!existsSync(summaryPath)) {
    writeFileSync(summaryPath, `Pipeline crashed: ${message}\n`);
  }
  exit(1);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Topological sort (Kahn's algorithm) that groups parallel steps into tiers.
 * Returns an array of tiers — each tier contains step IDs that can execute concurrently.
 * Falls back to one-step-per-tier (input order) if the graph has a cycle.
 */
function topoSortTiers(steps: Array<{ id: string; depends_on: string[] }>): string[][] {
  const inDegree = new Map(steps.map((s) => [s.id, s.depends_on.length]));
  let frontier: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) frontier.push(id);
  }
  frontier.sort();

  const tiers: string[][] = [];
  let processed = 0;
  while (frontier.length > 0) {
    tiers.push([...frontier]);
    processed += frontier.length;
    const next: string[] = [];
    for (const current of frontier) {
      for (const step of steps) {
        if (step.depends_on.includes(current)) {
          const nd = (inDegree.get(step.id) ?? 0) - 1;
          inDegree.set(step.id, nd);
          if (nd === 0) next.push(step.id);
        }
      }
    }
    next.sort();
    frontier = next;
  }

  if (processed !== steps.length) {
    return steps.map((s) => [s.id]);
  }
  return tiers;
}

/**
 * Format tiers into a human-readable execution order string.
 * Single-step tiers render as the step ID; multi-step tiers as `[a, b]`.
 */
function formatTiers(tiers: string[][]): string {
  return tiers
    .map((tier) => (tier.length === 1 ? (tier[0] ?? "") : `[${tier.join(", ")}]`))
    .join(" → ");
}

/** Walk a PipelineError's cause chain and print phase + message for each level. */
function formatPipelineError(error: PipelineError): void {
  console.error(`\nFailed at "${error.phase}": ${error.cause.message}`);
  let current: unknown = error.cause.cause;
  while (current instanceof Error) {
    console.error(`  caused by: ${current.message}`);
    current = current.cause;
  }
}

function printExecutionSummary(fsmId: string, report: ExecutionReport): void {
  const passCount = report.assertions.filter((a) => a.passed).length;
  const failCount = report.assertions.filter((a) => !a.passed).length;
  const status = report.success ? "OK" : "FAILED";

  console.log(`\nExecution [${fsmId}]: ${status}`);
  console.log(`  Final state: ${report.finalState}`);
  console.log(`  Transitions: ${report.stateTransitions.length}`);
  console.log(`  Assertions: ${passCount} passed, ${failCount} failed`);
  console.log(`  Duration: ${report.durationMs}ms`);

  if (failCount > 0) {
    for (const a of report.assertions.filter((a) => !a.passed)) {
      console.log(`  FAIL: ${a.check}${a.detail ? ` — ${a.detail}` : ""}`);
    }
  }

  if (report.error) {
    console.log(`  Error: ${report.error}`);
  }
}

function writeSummary(
  dir: string,
  plan: WorkspaceBlueprint,
  fsms: CompiledFSMDefinition[],
  hasWorkspaceYaml = false,
): void {
  const lines: string[] = [];
  lines.push(`Workspace: ${plan.workspace.name}`);
  lines.push(`Purpose: ${plan.workspace.purpose}`);
  lines.push(`Signals: ${plan.signals.length}`);
  lines.push(`Agents: ${plan.agents.length}`);
  const resSlugs = (plan.resources ?? []).map((r) => r.slug);
  lines.push(`Resources: ${resSlugs.length > 0 ? resSlugs.join(", ") : "none"}`);
  lines.push(`Jobs: ${plan.jobs.length}`);
  lines.push("");

  for (const job of plan.jobs) {
    const tiers = topoSortTiers(job.steps);
    lines.push(`Job: ${job.id} — ${job.name}`);
    lines.push(`  Steps: ${formatTiers(tiers)}`);
    lines.push(`  Contracts: ${job.documentContracts.length}`);
    lines.push(`  Mappings: ${job.prepareMappings.length}`);
  }

  if (fsms.length > 0) {
    lines.push("");
    lines.push("Compiled FSMs:");
    for (const fsm of fsms) {
      const stateCount = Object.keys(fsm.states).length;
      const funcCount = Object.keys(fsm.functions ?? {}).length;
      const docTypeCount = Object.keys(fsm.documentTypes ?? {}).length;
      lines.push(
        `  ${fsm.id}: ${stateCount} states, ${funcCount} functions, ${docTypeCount} doc types`,
      );
    }
  }

  if (hasWorkspaceYaml) {
    lines.push("");
    lines.push("workspace.yml: generated");
  }

  writeFileSync(join(dir, "summary.txt"), `${lines.join("\n")}\n`);
}
