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
 *   compare        Compare two tagged (or runId-identified) eval runs
 */

import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { cli, define } from "gunshi";

import { compareRuns } from "./lib/compare.ts";
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
    tag: {
      type: "string",
      short: "T",
      description: "Tag to attach to all results in this run (e.g., baseline, experiment-1)",
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

# Tag a run for later comparison
evals run --tag baseline
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

    const tag = ctx.values.tag;
    const results = await executeEvals(files, { failFast, filter, tag });

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

/**
 * Resolves eval results by trying tag match first, then falling back to runId.
 * Returns a flat array of EvalResult objects.
 */
async function resolveResults(identifier: string) {
  const byTag = await readOutputDir({ tag: identifier });
  if (byTag.size > 0) return [...byTag.values()].flat();

  const byRunId = await readOutputDir({ runId: identifier });
  if (byRunId.size > 0) return [...byRunId.values()].flat();

  return [];
}

const compareCommand = define({
  name: "compare",
  description: "Compare two tagged eval runs",
  args: {
    before: { type: "string", description: "Tag or runId for the baseline run", required: true },
    after: { type: "string", description: "Tag or runId for the experiment run", required: true },
    verbose: {
      type: "boolean",
      short: "v",
      description: "Include scoreReasons and promptDiff in output",
    },
  },
  examples: `
# Compare two tagged runs
evals compare --before baseline --after collapse-v1

# Verbose output with score reasons
evals compare --before baseline --after collapse-v1 --verbose
`.trim(),
  run: async (ctx) => {
    const { before, after, verbose } = ctx.values;
    if (!before || !after) {
      console.error("Error: --before and --after are required");
      process.exit(1);
    }

    const beforeResults = await resolveResults(before);
    if (beforeResults.length === 0) {
      console.error(`No results found for "${before}" (tried tag and runId)`);
      process.exit(1);
    }

    const afterResults = await resolveResults(after);
    if (afterResults.length === 0) {
      console.error(`No results found for "${after}" (tried tag and runId)`);
      process.exit(1);
    }

    const result = compareRuns(beforeResults, afterResults, {
      verbose,
      beforeLabel: before,
      afterLabel: after,
    });

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
    compare: compareCommand,
  },
});
