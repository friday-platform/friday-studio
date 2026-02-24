/**
 * do_task fastpath routing and speedup eval.
 *
 * Three eval groups:
 *
 * 1. **Routing** (`do-task/fastpath/{id}`) — Tests whether generatePlan +
 *    classifyAgents + isFastpathEligible correctly identify single-agent vs
 *    multi-agent tasks. Calls the planner directly — no daemon, no execution.
 *
 * 2. **Speedup** (`do-task/fastpath/speedup/{id}`) — For single-agent cases,
 *    runs BOTH paths on the same input: fastpath (plan + classify only) vs
 *    full pipeline (buildBlueprint with DAG, schemas, mappings). Measures
 *    the wall-time delta — the actual savings from skipping pipeline steps.
 *
 * 3. **E2E** (`do-task/fastpath/e2e/{id}`) — Sends real prompts to the running
 *    daemon via CLI, then queries logs for routing decision and timing data.
 *    Validates that the fastpath works end-to-end through execution. Requires
 *    a running daemon with fastpath instrumentation deployed.
 *
 * Run with:
 *   deno task evals run --filter do-task/fastpath           # all groups
 *   deno task evals run --filter do-task/fastpath/single    # routing only
 *   deno task evals run --filter do-task/fastpath/speedup   # speedup only
 *   deno task evals run --filter do-task/fastpath/e2e       # e2e only
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { createLogger } from "@atlas/logger";
import { isFastpathEligible } from "../../../../packages/system/agents/conversation/tools/do-task/fastpath.ts";
import { buildBlueprint } from "../../../../packages/workspace-builder/planner/build-blueprint.ts";
import { classifyAgents } from "../../../../packages/workspace-builder/planner/classify-agents.ts";
import {
  formatUserMessage,
  generatePlan,
  getSystemPrompt,
} from "../../../../packages/workspace-builder/planner/plan.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

const execFileAsync = promisify(execFile);

await loadCredentials();

const adapter = new AgentContextAdapter();
const logger = createLogger({ name: "fastpath-eval" });

async function fetchDynamicServers(): Promise<MCPServerMetadata[]> {
  try {
    const adapter = await getMCPRegistryAdapter();
    return await adapter.list();
  } catch {
    logger.warn("Failed to load dynamic MCP servers, classification will use static only");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FastpathRoutingCase extends BaseEvalCase {
  expectFastpath: boolean;
}

interface RoutingResult {
  agentCount: number;
  agentNames: string[];
  eligible: boolean;
  hasClarifications: boolean;
  planningMs: number;
}

interface SpeedupResult {
  fastpathMs: number;
  fullPipelineMs: number;
  savedMs: number;
  speedupRatio: number;
  agentName: string;
}

interface E2EResult {
  chatId: string;
  fastpath: boolean | null;
  planningMs: number | null;
  executionMs: number | null;
  totalMs: number | null;
  success: boolean;
}

/** Log entry shape from `deno task atlas logs` JSON output. */
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const singleAgentCases: FastpathRoutingCase[] = [
  {
    id: "single-bundled-calendar",
    name: "fastpath - calendar check",
    input: "check my calendar for today",
    expectFastpath: true,
  },
  {
    id: "single-llm-search",
    name: "fastpath - web search",
    input: "search the web for Deno 2.0 release notes",
    expectFastpath: true,
  },
  {
    id: "single-bundled-linear",
    name: "fastpath - Linear lookup",
    input: "what issues are assigned to me in Linear",
    expectFastpath: true,
  },
];

const multiAgentCases: FastpathRoutingCase[] = [
  {
    id: "multi-research-email",
    name: "full pipeline - research then email",
    input: "research the latest TypeScript features then email a summary to the team",
    expectFastpath: false,
  },
  {
    id: "multi-calendar-linear",
    name: "full pipeline - calendar to Linear",
    input: "check my calendar for conflicts this week and create a Linear issue for each one",
    expectFastpath: false,
  },
];

const allCases: FastpathRoutingCase[] = [...singleAgentCases, ...multiAgentCases];

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * Runs generatePlan + classifyAgents + isFastpathEligible and measures wall time.
 * No daemon, no execution — just the planning decision.
 */
async function runPlanningPhase(input: string): Promise<RoutingResult> {
  const start = Date.now();

  const plan = await generatePlan(input, { mode: "task" });
  const dynamicServers = await fetchDynamicServers();
  const classifyResult = await classifyAgents(plan.agents, { dynamicServers });
  const eligible = isFastpathEligible(plan, classifyResult);

  const planningMs = Date.now() - start;

  return {
    agentCount: plan.agents.length,
    agentNames: plan.agents.map((a) => a.name),
    eligible,
    hasClarifications: classifyResult.clarifications.length > 0,
    planningMs,
  };
}

/**
 * Runs both paths on the same input and measures the delta.
 *
 * 1. Fastpath: generatePlan + classifyAgents (what the fastpath actually does)
 * 2. Full pipeline: buildBlueprint with precomputed plan+classify, so only
 *    the remaining steps run (DAG + schemas + mappings)
 *
 * Both paths share the same plan+classify results, eliminating LLM variance
 * from the measurement. `savedMs` is the pipeline time the fastpath skips
 * entirely. `speedupRatio` compares fastpath e2e to full e2e:
 * `fastpathMs / (fastpathMs + fullPipelineMs)`.
 */
async function runSpeedupComparison(input: string): Promise<SpeedupResult> {
  // Run fastpath timing (plan + classify only)
  const fpStart = Date.now();
  const plan = await generatePlan(input, { mode: "task" });
  const dynamicServers = await fetchDynamicServers();
  const classifyResult = await classifyAgents(plan.agents, { dynamicServers });
  const fastpathMs = Date.now() - fpStart;

  const agentName = plan.agents[0]?.name ?? "unknown";

  // Verify this is actually a single-agent case
  if (!isFastpathEligible(plan, classifyResult)) {
    throw new Error(
      `Speedup eval requires fastpath-eligible input but got ` +
        `${plan.agents.length} agents: [${plan.agents.map((a) => a.name).join(", ")}]`,
    );
  }

  // Run remaining pipeline steps only (DAG + schemas + mappings)
  // Passes precomputed plan+classify so buildBlueprint skips those steps
  const bpStart = Date.now();
  await buildBlueprint(input, {
    mode: "task",
    logger,
    precomputed: { plan, classified: classifyResult },
  });
  const fullPipelineMs = Date.now() - bpStart;

  const savedMs = fullPipelineMs;
  const totalIfFull = fastpathMs + fullPipelineMs;
  const speedupRatio = totalIfFull > 0 ? fastpathMs / totalIfFull : 1;

  return { fastpathMs, fullPipelineMs, savedMs, speedupRatio, agentName };
}

/**
 * Sends a prompt to the running daemon via CLI, then queries logs for the
 * routing decision and timing data from the `do_task completed` log line.
 *
 * Requires daemon running with fastpath + timing instrumentation deployed.
 */
async function sendPromptAndCollectTiming(input: string): Promise<E2EResult> {
  const { stdout: promptOutput } = await execFileAsync("deno", ["task", "atlas", "prompt", input], {
    timeout: 600_000,
  });

  const lines = promptOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error("No output from CLI prompt command");
  }
  const summary = JSON.parse(lastLine) as { type: string; chatId: string };
  if (summary.type !== "cli-summary") {
    throw new Error(`Expected cli-summary, got ${summary.type}`);
  }
  const { chatId } = summary;

  const { stdout: logOutput } = await execFileAsync(
    "deno",
    ["task", "atlas", "logs", "--chat", chatId],
    { timeout: 30_000 },
  );

  const logLines = logOutput
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogEntry);

  const completionLog = logLines.find((l) => l.message === "do_task completed");

  if (!completionLog) {
    return {
      chatId,
      fastpath: null,
      planningMs: null,
      executionMs: null,
      totalMs: null,
      success: false,
    };
  }

  const ctx = completionLog.context;
  return {
    chatId,
    fastpath: typeof ctx.fastpath === "boolean" ? ctx.fastpath : null,
    planningMs: typeof ctx.planningMs === "number" ? ctx.planningMs : null,
    executionMs: typeof ctx.executionMs === "number" ? ctx.executionMs : null,
    totalMs: typeof ctx.durationMs === "number" ? ctx.durationMs : null,
    success: ctx.success === true,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const MAX_PLANNING_MS = 15_000;

// ---------------------------------------------------------------------------
// Routing evals — all cases
// ---------------------------------------------------------------------------

const routingEvals: EvalRegistration[] = allCases.map((testCase) =>
  defineEval({
    name: `do-task/fastpath/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await runPlanningPhase(input),
      assert: (result) => {
        if (testCase.expectFastpath && !result.eligible) {
          throw new Error(
            `Expected fastpath-eligible but gate returned false ` +
              `(${result.agentCount} agents: [${result.agentNames.join(", ")}], ` +
              `clarifications: ${result.hasClarifications})`,
          );
        }
        if (!testCase.expectFastpath && result.eligible) {
          throw new Error(
            `Expected full pipeline but gate returned fastpath-eligible ` +
              `(${result.agentCount} agents: [${result.agentNames.join(", ")}])`,
          );
        }
      },
      score: (result) => [
        createScore(
          "routing/correct",
          result.eligible === testCase.expectFastpath ? 1 : 0,
          result.eligible === testCase.expectFastpath
            ? "Correct routing decision"
            : `Expected fastpath=${testCase.expectFastpath}, got ${result.eligible}`,
        ),
        createScore(
          "routing/agent-count",
          testCase.expectFastpath
            ? result.agentCount === 1
              ? 1
              : 0
            : result.agentCount > 1
              ? 1
              : 0,
          `${result.agentCount} agent(s): [${result.agentNames.join(", ")}]`,
        ),
        createScore(
          "timing/planning-ms",
          Math.min(result.planningMs / MAX_PLANNING_MS, 1),
          `${result.planningMs}ms`,
        ),
      ],
      metadata: {
        expectFastpath: testCase.expectFastpath,
        promptSnapshot: getSystemPrompt("task"),
        userMessage: formatUserMessage(testCase.input, "task"),
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// Speedup evals — single-agent cases only
// ---------------------------------------------------------------------------

const speedupEvals: EvalRegistration[] = singleAgentCases.map((testCase) =>
  defineEval({
    name: `do-task/fastpath/speedup/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await runSpeedupComparison(input),
      score: (result) => [
        createScore(
          "speedup/saved-ms",
          Math.min(result.savedMs / 30_000, 1),
          `${result.savedMs}ms pipeline steps skipped (${result.agentName})`,
        ),
        createScore(
          "speedup/ratio",
          1 - result.speedupRatio,
          `fastpath=${result.fastpathMs}ms, full=${result.fullPipelineMs}ms ` +
            `(${Math.round((1 - result.speedupRatio) * 100)}% faster)`,
        ),
        createScore(
          "speedup/fastpath-ms",
          Math.min(result.fastpathMs / MAX_PLANNING_MS, 1),
          `${result.fastpathMs}ms`,
        ),
        createScore(
          "speedup/full-pipeline-ms",
          Math.min(result.fullPipelineMs / 30_000, 1),
          `${result.fullPipelineMs}ms`,
        ),
      ],
      metadata: {
        promptSnapshot: getSystemPrompt("task"),
        userMessage: formatUserMessage(testCase.input, "task"),
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// E2E evals — all cases, requires running daemon
// ---------------------------------------------------------------------------

const MAX_E2E_TOTAL_MS = 60_000;
const MAX_E2E_EXECUTION_MS = 60_000;

const e2eEvals: EvalRegistration[] = allCases.map((testCase) =>
  defineEval({
    name: `do-task/fastpath/e2e/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await sendPromptAndCollectTiming(input),
      assert: (result) => {
        if (result.fastpath === null) {
          throw new Error(
            `No timing data in logs (chatId: ${result.chatId}) — is the daemon running with fastpath instrumentation?`,
          );
        }
        if (testCase.expectFastpath && !result.fastpath) {
          throw new Error(`Expected fastpath but got full pipeline (chatId: ${result.chatId})`);
        }
        if (!testCase.expectFastpath && result.fastpath) {
          throw new Error(`Expected full pipeline but got fastpath (chatId: ${result.chatId})`);
        }
      },
      score: (result) => {
        const scores = [
          createScore(
            "e2e/routing-correct",
            result.fastpath === testCase.expectFastpath ? 1 : 0,
            result.fastpath === testCase.expectFastpath
              ? "Correct routing"
              : `Expected fastpath=${testCase.expectFastpath}, got ${result.fastpath}`,
          ),
          createScore(
            "e2e/task-success",
            result.success ? 1 : 0,
            result.success ? "Task completed" : `Task failed (chatId: ${result.chatId})`,
          ),
        ];

        if (result.totalMs !== null) {
          scores.push(
            createScore(
              "e2e/total-ms",
              Math.min(result.totalMs / MAX_E2E_TOTAL_MS, 1),
              `${result.totalMs}ms total`,
            ),
          );
        }

        if (result.planningMs !== null) {
          scores.push(
            createScore(
              "e2e/planning-ms",
              Math.min(result.planningMs / MAX_PLANNING_MS, 1),
              `${result.planningMs}ms planning`,
            ),
          );
        }

        if (result.executionMs !== null) {
          scores.push(
            createScore(
              "e2e/execution-ms",
              Math.min(result.executionMs / MAX_E2E_EXECUTION_MS, 1),
              `${result.executionMs}ms execution`,
            ),
          );
        }

        return scores;
      },
      metadata: {
        expectFastpath: testCase.expectFastpath,
        promptSnapshot: getSystemPrompt("task"),
        userMessage: formatUserMessage(testCase.input, "task"),
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = [...routingEvals, ...speedupEvals, ...e2eEvals];
