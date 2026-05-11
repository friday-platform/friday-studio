#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Runner skeleton for OAuth refresh-resilience QA scenarios.
 *
 * Orchestration: start mock → start daemon → open browser → run scenarios →
 * tear down. This file is the CLI entry point. The reusable pieces
 * (scenario registry, filter, lifecycle, arg parsing) live in
 * `run-core.ts` so unit tests can exercise them without the Deno-only
 * daemon harness.
 *
 * Usage:
 *   deno run --allow-all tools/qa/oauth-resilience/run.ts
 *   deno run --allow-all tools/qa/oauth-resilience/run.ts --filter "P1-"
 *   deno run --allow-all tools/qa/oauth-resilience/run.ts --fail-fast --verbose
 *   deno run --allow-all tools/qa/oauth-resilience/run.ts --list
 */

import { type ChromeHandle, openChrome } from "./browser.ts";
import {
  type DaemonHandle,
  startDaemon as startQaDaemon,
  stopDaemon as stopQaDaemon,
} from "./daemon.ts";
import { type MockHandle, startMock, stopMock } from "./mock.ts";
import {
  filterScenarios,
  formatHelp,
  listScenarios,
  parseArgs,
  runScenario,
  type ScenarioResult,
  toScenarioContext,
} from "./run-core.ts";
// Scenario registration: each file calls `register({...})` at module load.
// Add new phases by appending another import — order matches Phase number.
import "./scenarios/p1.ts";
import "./scenarios/p2.ts";

export type {
  Scenario,
  ScenarioContext,
  ScenarioResult,
} from "./run-core.ts";
export {
  filterScenarios,
  formatHelp,
  listScenarios,
  parseArgs,
  register,
  resetRegistry,
  runScenario,
  toScenarioContext,
} from "./run-core.ts";

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(Deno.args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(formatHelp());
    Deno.exit(2);
  }

  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(formatHelp());
    return;
  }

  const scenarios = filterScenarios(listScenarios(), args.filter);

  if (args.list) {
    if (scenarios.length === 0) {
      console.log("(no scenarios registered)");
      return;
    }
    for (const s of scenarios) console.log(`${s.id}\t${s.description}`);
    return;
  }

  if (scenarios.length === 0) {
    console.log(
      args.filter
        ? `no scenarios match filter ${JSON.stringify(args.filter)}`
        : "no scenarios registered — runner is a skeleton until tasks #22+ ship",
    );
    return;
  }

  const mock: MockHandle = await startMock(0);
  let daemon: DaemonHandle | null = null;
  let browser: ChromeHandle | null = null;
  const results: ScenarioResult[] = [];

  try {
    daemon = await startQaDaemon({ mockBaseUrl: mock.url });
    if (args.verbose) console.log(`✓ daemon up: ${daemon.baseUrl}`);
    browser = await openChrome();
    if (args.verbose) console.log(`✓ chrome up: ${browser.debugUrl}`);

    const ctx = toScenarioContext(mock, daemon, browser);

    for (const scenario of scenarios) {
      const result = await runScenario(scenario, ctx, {
        verbose: args.verbose,
        logger: { log: (line) => console.log(line) },
      });
      results.push(result);
      if (result.status === "failed" && args.failFast) break;
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error("browser close failed:", err);
      }
    }
    if (daemon) {
      try {
        await stopQaDaemon(daemon);
      } catch (err) {
        console.error("daemon stop failed:", err);
      }
    }
    try {
      await stopMock(mock);
    } catch (err) {
      console.error("mock stop failed:", err);
    }
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log("");
  console.log(`══ oauth-resilience: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    const mark = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "·";
    console.log(`${mark} ${r.id} (${r.durationMs}ms)`);
    if (r.error) {
      for (const line of r.error.split("\n")) console.log(`    ${line}`);
    }
  }
  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
