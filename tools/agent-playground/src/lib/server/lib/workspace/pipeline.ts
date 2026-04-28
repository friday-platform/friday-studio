/**
 * Workspace pipeline — pure functions for workspace execution.
 *
 * Each phase accepts explicit parameters and returns results. No CLI concerns
 * (arg parsing, console output, process.exit, filesystem writes). Callers
 * (server routes, CLI entrypoint) decide how to persist and present results.
 *
 * @module
 */

import { createPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import {
  buildBlueprint,
  buildFSMFromPlan,
  buildWorkspaceYaml,
  type BlueprintProgressEvent,
  type BlueprintResult,
  type BuildBlueprintOpts,
  type CompiledFSMDefinition,
  type CompileWarning,
  type WorkspaceBlueprint,
} from "@atlas/workspace-builder";
import { createDirectMCPExecutor, type AgentTraceEntry } from "./direct-executor.ts";
import { runFSM, type ExecutionReport } from "./run-fsm.ts";

// ---------------------------------------------------------------------------
// Phase 1: Blueprint generation (LLM-backed)
// ---------------------------------------------------------------------------

export type { BlueprintResult };

/**
 * Generate a workspace blueprint from a natural language prompt.
 *
 * Wraps `buildBlueprint()` with the workspace-specific mode. Returns the full
 * blueprint result including clarifications and credential state.
 *
 * @param prompt - Natural language description of the workspace
 * @param opts - Logger and optional abort signal
 * @returns Blueprint result with plan, clarifications, credentials, and readiness
 */
function generateBlueprint(
  prompt: string,
  opts: { logger: Logger; abortSignal?: AbortSignal; onProgress?: (event: BlueprintProgressEvent) => void },
): Promise<BlueprintResult> {
  const buildOpts: BuildBlueprintOpts = {
    mode: "workspace",
    logger: opts.logger,
    abortSignal: opts.abortSignal,
    onProgress: opts.onProgress,
    platformModels: createPlatformModels(null),
  };
  return buildBlueprint(prompt, buildOpts);
}

// ---------------------------------------------------------------------------
// Phase 2: FSM compilation (pure, deterministic)
// ---------------------------------------------------------------------------

/** Result of compiling all jobs in a blueprint to FSMs. */
export interface CompileResult {
  fsms: CompiledFSMDefinition[];
  warnings: Array<{ jobId: string; warnings: CompileWarning[] }>;
}

/**
 * Compile all jobs in a blueprint to FSM definitions.
 *
 * Iterates each job and compiles it. Throws on the first compilation failure.
 *
 * @param plan - The workspace blueprint containing jobs to compile
 * @returns Compiled FSMs and any compiler warnings
 * @throws {Error} When FSM compilation fails for any job
 */
export function compileFSMs(plan: WorkspaceBlueprint): CompileResult {
  const fsms: CompiledFSMDefinition[] = [];
  const warnings: CompileResult["warnings"] = [];

  for (const job of plan.jobs) {
    const result = buildFSMFromPlan(job);
    if (!result.success) {
      throw new Error(
        `FSM compilation failed for ${job.id}: ${result.error.map((e) => e.message).join("; ")}`,
      );
    }
    fsms.push(result.value.fsm);
    warnings.push({ jobId: job.id, warnings: result.value.warnings });
  }

  return { fsms, warnings };
}

// ---------------------------------------------------------------------------
// Phase 3: Workspace YAML assembly (pure)
// ---------------------------------------------------------------------------

/** Result of assembling a workspace.yml string. */
export interface AssembleResult {
  yaml: string;
}

/**
 * Assemble a workspace.yml string from blueprint and compiled FSMs.
 *
 * @param plan - The workspace blueprint
 * @param fsms - Compiled FSM definitions
 * @param bindings - Optional credential bindings for MCP server and agent env
 * @returns The assembled workspace.yml content
 */
export function assembleWorkspaceYml(
  plan: WorkspaceBlueprint,
  fsms: CompiledFSMDefinition[],
  bindings?: BlueprintResult["credentials"]["bindings"],
): AssembleResult {
  const phase1 = { workspace: plan.workspace, signals: plan.signals, agents: plan.agents };
  const yaml = buildWorkspaceYaml(phase1, plan, fsms, bindings);
  return { yaml };
}

// ---------------------------------------------------------------------------
// Phase 4: FSM execution (optional)
// ---------------------------------------------------------------------------

/** Options for executing compiled FSMs. */
export interface ExecuteOptions {
  plan: WorkspaceBlueprint;
  fsms: CompiledFSMDefinition[];
  /** Use real MCP agents instead of deterministic mocks. */
  real?: boolean;
  /** Data passed as signal payload to the trigger signal. */
  signalPayload?: Record<string, unknown>;
  /** Called on each state transition for live streaming. */
  onTransition?: (transition: {
    from: string;
    to: string;
    signal: string;
    timestamp: number;
    resultSnapshot: Record<string, Record<string, unknown>>;
  }) => void;
  /** Called on each action execution for live streaming. */
  onAction?: (action: {
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  }) => void;
  /** Called after each agent LLM call with trace data (model, tokens, latency). */
  onTrace?: (trace: AgentTraceEntry) => void;
}

/** Result of executing all FSMs in a pipeline. */
export interface ExecuteResult {
  reports: ExecutionReport[];
}

/**
 * Execute compiled FSMs through the harness.
 *
 * Runs each FSM against its trigger signal. In mock mode (default), uses
 * deterministic stubs. In real mode, spins up MCP server connections and
 * runs agents via AI SDK generateText.
 *
 * @param opts - Execution options (plan, FSMs, mock/real mode)
 * @returns Execution reports for each FSM
 * @throws {Error} When any FSM execution fails
 */
export async function executeFSMs(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { plan, fsms, real = false, signalPayload, onTransition, onAction, onTrace } = opts;

  let realExecutorHandle:
    | { executor: Parameters<typeof runFSM>[0]["agentExecutor"]; shutdown: () => Promise<void> }
    | undefined;

  if (real) {
    realExecutorHandle = createDirectMCPExecutor({ plan, onTrace });
  }

  const reports: ExecutionReport[] = [];

  try {
    for (const fsm of fsms) {
      const job = plan.jobs.find((j) => j.id === fsm.id);
      if (!job) continue;

      const report = await runFSM({
        fsm,
        plan,
        triggerSignal: job.triggerSignalId,
        signalPayload,
        agentExecutor: realExecutorHandle?.executor,
        onTransition,
        onAction,
      });

      reports.push(report);

      if (!report.success) {
        throw new Error(report.error ?? `FSM execution failed for ${fsm.id}`);
      }
    }
  } finally {
    await realExecutorHandle?.shutdown();
  }

  return { reports };
}

// ---------------------------------------------------------------------------
// Full pipeline (convenience)
// ---------------------------------------------------------------------------

/** Stop-at control for partial pipeline execution. */
export type StopAt = "plan" | "fsm" | undefined;

/** Phase progress events emitted at pipeline phase boundaries. */
export type PhaseEvent =
  | { name: "blueprint"; blueprint: WorkspaceBlueprint }
  | { name: "compile"; compilation: CompileResult }
  | { name: "assemble"; yaml: string | undefined };

/** Options for the full pipeline. */
export interface PipelineOptions {
  prompt: string;
  /** Raw user input passed as signal payload (mapped to schema fields). */
  input?: string;
  logger: Logger;
  stopAt?: StopAt;
  real?: boolean;
  abortSignal?: AbortSignal;
  /** Called at pipeline phase boundaries for incremental progress reporting. */
  onPhase?: (phase: PhaseEvent) => void;
  /** Called at sub-phase milestones during blueprint generation for progressive UI. */
  onBlueprintProgress?: (event: BlueprintProgressEvent) => void;
  /** Called on each state transition for live SSE streaming. */
  onTransition?: (transition: {
    from: string;
    to: string;
    signal: string;
    timestamp: number;
    resultSnapshot: Record<string, Record<string, unknown>>;
  }) => void;
  /** Called on each action execution for live SSE streaming. */
  onAction?: (action: {
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  }) => void;
  /** Called after each agent LLM call with trace data. */
  onTrace?: (trace: AgentTraceEntry) => void;
}

/** Full pipeline result — each phase is present only if it ran. */
export interface PipelineResult {
  blueprint: BlueprintResult;
  compilation?: CompileResult;
  workspaceYaml?: string;
  execution?: ExecuteResult;
}

/**
 * Run the full workspace pipeline: prompt -> blueprint -> FSM -> execute.
 *
 * Supports partial execution via `stopAt`:
 * - `"plan"` — stops after blueprint generation
 * - `"fsm"` — stops after FSM compilation (includes workspace.yml assembly)
 * - `undefined` — runs all phases including execution
 *
 * @param opts - Pipeline options
 * @returns Results from each phase that was executed
 * @throws {PipelineError} From blueprint generation
 * @throws {Error} From FSM compilation or execution
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { prompt, input, logger, stopAt, real, abortSignal, onPhase, onBlueprintProgress, onTransition, onAction, onTrace } =
    opts;

  // Phase 1: Blueprint
  const blueprint = await generateBlueprint(prompt, { logger, abortSignal, onProgress: onBlueprintProgress });
  onPhase?.({ name: "blueprint", blueprint: blueprint.blueprint });

  if (stopAt === "plan") {
    return { blueprint };
  }

  // Phase 2: Compile
  const compilation = compileFSMs(blueprint.blueprint);
  onPhase?.({ name: "compile", compilation });

  // Phase 3: Workspace YAML (non-fatal)
  let workspaceYaml: string | undefined;
  if (compilation.fsms.length > 0) {
    try {
      const assembled = assembleWorkspaceYml(
        blueprint.blueprint,
        compilation.fsms,
        blueprint.credentials.bindings,
      );
      workspaceYaml = assembled.yaml;
    } catch {
      // workspace.yml assembly failure is non-fatal
    }
  }
  onPhase?.({ name: "assemble", yaml: workspaceYaml });

  if (stopAt === "fsm") {
    return { blueprint, compilation, workspaceYaml };
  }

  // Phase 4: Execute
  let execution: ExecuteResult | undefined;
  if (compilation.fsms.length > 0) {
    // Build signal payload from blueprint's signal schema if user input provided
    let signalPayload: Record<string, unknown> | undefined;
    if (input) {
      const firstSignal = blueprint.blueprint.signals[0];
      const schema = firstSignal?.payloadSchema as Record<string, unknown> | undefined;
      const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        signalPayload = {};
        for (const [key, prop] of Object.entries(props)) {
          if (prop.type === "string") {
            signalPayload[key] = input;
          }
        }
      }
      if (!signalPayload || Object.keys(signalPayload).length === 0) {
        signalPayload = { input };
      }
    }

    execution = await executeFSMs({
      plan: blueprint.blueprint,
      fsms: compilation.fsms,
      real,
      signalPayload,
      onTransition,
      onAction,
      onTrace,
    });
  }

  return { blueprint, compilation, workspaceYaml, execution };
}
