/**
 * Pure runner primitives — scenario registry, filtering, CLI parsing, and
 * per-scenario lifecycle. Split out from `run.ts` so vitest can exercise
 * them without pulling in the live-daemon harness (Deno-only jsr: imports).
 */

import type { BrowserController, ChromeHandle } from "./browser.ts";
import type { DaemonHandle } from "./daemon.ts";
import { type MockHandle, mockControl } from "./mock.ts";

/**
 * What scenarios receive. `browser` is intentionally typed as the narrower
 * `BrowserController` (not `ChromeHandle`) — scenarios shouldn't be poking
 * the underlying Chrome process; the runner is responsible for spawn/teardown.
 * Same applies to `daemon`: scenarios call `daemon.baseUrl` and friends via
 * helpers; they don't need to touch `daemon.process` directly.
 *
 * Typing this loose also lets unit tests build a context without fabricating
 * Deno-only types like `Deno.ChildProcess`.
 */
export interface ScenarioContext {
  mock: MockHandle;
  daemon: ScenarioDaemonHandle;
  browser: BrowserController;
}

/** Subset of `DaemonHandle` scenarios are allowed to depend on. */
export interface ScenarioDaemonHandle {
  port: number;
  baseUrl: string;
  fridayHome: string;
  natsUrl: string;
}

/** Internal helper so the runner can hand the full handle in production. */
export function toScenarioContext(
  mock: MockHandle,
  daemon: DaemonHandle,
  browser: ChromeHandle,
): ScenarioContext {
  return {
    mock,
    daemon: {
      port: daemon.port,
      baseUrl: daemon.baseUrl,
      fridayHome: daemon.fridayHome,
      natsUrl: daemon.natsUrl,
    },
    browser,
  };
}

export interface Scenario {
  /** Stable id matching the QA plan, e.g. "P1-01". Used by --filter. */
  id: string;
  /** Short human-readable description for log output. */
  description: string;
  /** Body invoked after per-scenario reset. */
  run: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioResult {
  id: string;
  description: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
}

const registry: Scenario[] = [];

/**
 * Register a scenario. Scenarios (tasks #22+) call this at module load.
 * Order of registration is preserved.
 */
export function register(scenario: Scenario): void {
  if (registry.some((s) => s.id === scenario.id)) {
    throw new Error(`scenario ${scenario.id} is already registered`);
  }
  registry.push(scenario);
}

/** Reset the registry. Test-only — production runs only ever register. */
export function resetRegistry(): void {
  registry.length = 0;
}

export function listScenarios(): ReadonlyArray<Scenario> {
  return [...registry];
}

export function filterScenarios(
  scenarios: ReadonlyArray<Scenario>,
  filter: string | undefined,
): Scenario[] {
  if (!filter || filter.length === 0) return [...scenarios];
  return scenarios.filter((s) => s.id.includes(filter));
}

/**
 * Reset all per-scenario state. Called before each `scenario.run()`:
 *   - mock back to `"success"` + counts cleared
 *
 * Per-credential tampering is the scenario's responsibility — different
 * scenarios want very different starting credential states (expired vs
 * fresh vs corrupted refresh_token).
 */
async function resetForScenario(ctx: ScenarioContext): Promise<void> {
  await mockControl(ctx.mock, { mode: "success", resetCounts: true });
}

export interface RunScenarioLogger {
  log(line: string): void;
}

const noopLogger: RunScenarioLogger = { log: () => {} };

/**
 * Run a single scenario with the shared context. Catches and reports
 * failures rather than propagating, so the caller can decide on fail-fast
 * vs continue.
 */
export async function runScenario(
  scenario: Scenario,
  ctx: ScenarioContext,
  options: { verbose?: boolean; logger?: RunScenarioLogger } = {},
): Promise<ScenarioResult> {
  const verbose = options.verbose ?? false;
  const logger = options.logger ?? noopLogger;
  if (verbose) logger.log(`▶ ${scenario.id} — ${scenario.description}`);
  const startedAt = Date.now();
  try {
    await resetForScenario(ctx);
    await scenario.run(ctx);
    const durationMs = Date.now() - startedAt;
    if (verbose) logger.log(`  ✓ ${scenario.id} (${durationMs}ms)`);
    return { id: scenario.id, description: scenario.description, status: "passed", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    if (verbose) logger.log(`  ✗ ${scenario.id} (${durationMs}ms)\n    ${message}`);
    return {
      id: scenario.id,
      description: scenario.description,
      status: "failed",
      durationMs,
      error: message,
    };
  }
}

export interface CliArgs {
  filter?: string;
  failFast: boolean;
  verbose: boolean;
  list: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let filter: string | undefined;
  let failFast = false;
  let verbose = false;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--filter") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--filter requires a value");
      filter = next;
      i += 1;
    } else if (arg?.startsWith("--filter=")) {
      filter = arg.slice("--filter=".length);
    } else if (arg === "--fail-fast") {
      failFast = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--help" || arg === "-h") {
      return { filter, failFast, verbose, list: true };
    } else if (arg?.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return { filter, failFast, verbose, list };
}

export function formatHelp(): string {
  return [
    "Usage: run.ts [--filter <prefix>] [--fail-fast] [--verbose] [--list]",
    "",
    "Flags:",
    "  --filter <substr>  Run only scenarios whose id includes <substr>",
    "  --fail-fast        Stop on first failed scenario",
    "  --verbose, -v      Print per-scenario lifecycle log lines",
    "  --list             List registered scenarios and exit",
    "  --help, -h         Show this message",
  ].join("\n");
}

export type { BrowserController, ChromeHandle } from "./browser.ts";
