#!/usr/bin/env -S deno run --allow-all

/**
 * evals CLI — powered by gunshi.
 *
 * All output is JSON. Designed for agent consumption.
 *
 * Subcommands:
 *   run            Run eval files through custom runner
 *   list           List available eval files
 *   report         Show summary of latest eval results
 *   inspect        Show full eval result for a specific eval
 *   baseline save  Save current results as baseline for regression detection
 *   baseline show  Print the current baseline
 *   diff           Compare current results against baseline
 */

import { execSync } from "node:child_process";
import { glob, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { cli, define } from "gunshi";

import { BaselineSchema, extractBaseline } from "./lib/baseline.ts";
import { computeDiff } from "./lib/diff.ts";
import { readOutputDir } from "./lib/output.ts";
import { buildReport } from "./lib/report.ts";
import { executeEvals } from "./lib/runner.ts";

/** Prints a value as formatted JSON to stdout. */
function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Collect eval files matching the glob pattern. */
async function collectEvalFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const match of glob("tools/evals/**/*.eval.ts")) {
    files.push(resolve(match));
  }
  return files;
}

const runCommand = define({
  name: "run",
  description: "Run eval files through custom runner",
  args: {
    target: {
      type: "string",
      short: "t",
      description: "Specific eval file to run (runs all *.eval.ts if omitted)",
    },
    "fail-fast": { type: "boolean", short: "f", description: "Stop after the first eval failure" },
    filter: {
      type: "string",
      short: "F",
      description: "Run only evals whose name contains this string (case-insensitive)",
    },
  },
  examples: `
# Run all evals
evals run

# Run a specific eval file
evals run -t tools/evals/agents/small-llm/small-llm.eval.ts

# Stop on first failure
evals run --fail-fast

# Run only evals matching "refusal"
evals run --filter refusal
`.trim(),
  run: async (ctx) => {
    const { target } = ctx.values;
    const failFast = ctx.values["fail-fast"];
    const filter = ctx.values.filter;
    let files: string[];

    if (target) {
      files = [resolve(target)];
    } else {
      files = await collectEvalFiles();
      if (files.length === 0) {
        console.error("No .eval.ts files found");
        process.exit(1);
      }
    }

    const results = await executeEvals(files, { failFast, filter });

    const passed = results.filter((r) => !r.metadata.error).length;
    const failed = results.length - passed;

    json({ results, summary: { total: results.length, passed, failed } });

    if (failed > 0) {
      process.exit(1);
    }
  },
});

const listCommand = define({
  name: "list",
  description: "List available eval files",
  run: async () => {
    const files = await collectEvalFiles();
    json(files);
  },
});

const reportCommand = define({
  name: "report",
  description: "Show summary of latest eval results",
  args: { failures: { type: "boolean", short: "f", description: "Show only failed evals" } },
  examples: `
# Show report
evals report

# Only failures
evals report --failures
`.trim(),
  run: async (ctx) => {
    const grouped = await readOutputDir({ latest: true });

    if (grouped.size === 0) {
      console.error("No eval results found in __output__/");
      process.exit(1);
    }

    const report = buildReport(grouped);

    if (ctx.values.failures) {
      report.rows = report.rows.filter((r) => !r.passed);
    }

    json(report);
  },
});

const inspectCommand = define({
  name: "inspect",
  description: "Show full eval result as JSON",
  args: {
    eval: {
      type: "string",
      short: "e",
      description: "Eval name to inspect (e.g. data-analyst/ctr)",
      required: true,
    },
    run: { type: "string", short: "r", description: "Inspect a specific run ID instead of latest" },
  },
  examples: `
# Inspect latest result for an eval
evals inspect -e data-analyst/ctr

# Inspect a specific run
evals inspect -e small-llm/Groq/progress/tool-read --run abc123
`.trim(),
  run: async (ctx) => {
    const evalName = ctx.values.eval;
    if (!evalName) {
      console.error("Error: eval name is required (-e <name>)");
      process.exit(1);
    }

    const grouped = await readOutputDir({
      latest: !ctx.values.run,
      runId: ctx.values.run ?? undefined,
      evalName,
    });

    if (grouped.size === 0) {
      const msg = ctx.values.run
        ? `No results found for "${evalName}" with run ID "${ctx.values.run}"`
        : `No results found for "${evalName}"`;
      console.error(msg);
      process.exit(1);
    }

    const entry = [...grouped.entries()][0];
    if (!entry) {
      console.error(`No results found for "${evalName}"`);
      process.exit(1);
    }
    const [, results] = entry;
    const latest = results[results.length - 1];
    if (!latest) {
      console.error(`No results found for "${evalName}"`);
      process.exit(1);
    }

    json(latest);
  },
});

/** Resolve the current git commit hash. */
function getCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const BASELINE_PATH = join(import.meta.dirname ?? ".", "baseline.json");

const baselineSaveCommand = define({
  name: "save",
  description: "Save current eval results as the baseline",
  run: async () => {
    const grouped = await readOutputDir({ latest: true });

    if (grouped.size === 0) {
      console.error("No eval results found in __output__/");
      process.exit(1);
    }

    const commitHash = getCommitHash();
    const baseline = extractBaseline(grouped, commitHash);

    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");

    json({
      saved: true,
      path: "tools/evals/baseline.json",
      count: Object.keys(baseline.evals).length,
      commit: commitHash,
    });
  },
});

const baselineShowCommand = define({
  name: "show",
  description: "Print the current baseline",
  run: async () => {
    let raw: string;
    try {
      raw = await readFile(BASELINE_PATH, "utf-8");
    } catch {
      console.error("No baseline found. Run 'evals baseline save' first.");
      process.exit(1);
    }

    const baseline = BaselineSchema.parse(JSON.parse(raw));
    json(baseline);
  },
});

const baselineCommand = define({
  name: "baseline",
  description: "Manage eval baselines for regression detection",
  subCommands: { save: baselineSaveCommand, show: baselineShowCommand },
  run: () => {
    console.error('Use "evals baseline save" or "evals baseline show". Run --help for details.');
  },
});

const diffCommand = define({
  name: "diff",
  description: "Compare current eval results against baseline",
  args: {
    baseline: {
      type: "boolean",
      short: "b",
      description: "Compare against committed baseline.json",
      required: true,
    },
  },
  examples: `
# Compare current results against baseline
evals diff --baseline
`.trim(),
  run: async () => {
    let raw: string;
    try {
      raw = await readFile(BASELINE_PATH, "utf-8");
    } catch {
      console.error("No baseline found. Run 'evals baseline save' first.");
      process.exit(1);
    }

    const baseline = BaselineSchema.parse(JSON.parse(raw));

    const grouped = await readOutputDir({ latest: true });
    if (grouped.size === 0) {
      console.error("No eval results found in __output__/");
      process.exit(1);
    }

    const commitHash = getCommitHash();
    const current = extractBaseline(grouped, commitHash);
    const result = computeDiff(baseline, current);

    json(result);

    if (result.summary.regressed > 0) {
      process.exit(1);
    }
  },
});

const mainCommand = define({
  name: "evals",
  description: "Atlas eval harness CLI",
  run: () => {
    console.error('Use "evals run" to execute evals or "evals --help" for details.');
  },
});

await cli(process.argv.slice(2), mainCommand, {
  name: "evals",
  version: "0.1.0",
  description: "Atlas eval harness CLI",
  subCommands: {
    run: runCommand,
    list: listCommand,
    report: reportCommand,
    inspect: inspectCommand,
    baseline: baselineCommand,
    diff: diffCommand,
  },
});
