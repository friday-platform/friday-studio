/**
 * Deterministic compiler: ClassifiedJobWithDAG → FSMDefinition
 *
 * Pure function. No LLM calls, no side effects. Same input always produces same output.
 * Replaces LLM code generation for FSM wiring with graph traversal + template code.
 *
 * The FSM engine is single-state (no parallel execution), so the compiler linearizes
 * the DAG via topological sort. Each step transitions to the next step in sort order.
 * Fan-in guards ensure all upstream documents exist before a join step executes.
 * Conditional branches use transition arrays with value-matching guards.
 */

import { FSMBuilder } from "../builder.ts";
import { agentAction, emitAction } from "../helpers.ts";
import type { ClassifiedJobWithDAG } from "../planner/stamp-execution-types.ts";
import { type TopologicalSortError, topologicalSort } from "../topological-sort.ts";
import type {
  BuildError,
  ClassifiedDAGStep,
  CompiledFSMDefinition,
  Conditional,
  DocumentContract,
  Result,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default LLM provider for ad-hoc LLM agents. */
export const DEFAULT_LLM_PROVIDER = "anthropic";

/** Default LLM model for ad-hoc LLM agents. */
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Error specific to plan compilation (distinct from FSMBuilder's BuildError) */
export type { TopologicalSortError as CompileError } from "../topological-sort.ts";

/** Non-fatal issue detected during compilation */
export type CompileWarning = NoOutputContractWarning;

interface NoOutputContractWarning {
  type: "no_output_contract";
  stepId: string;
  agentId: string;
  message: string;
}

export interface CompilerOutput {
  fsm: CompiledFSMDefinition;
  warnings: CompileWarning[];
}

type CompilerResult = Result<CompilerOutput, (TopologicalSortError | BuildError)[]>;

/** Pre-computed indexes and validation results for a single job compilation. */
export interface CompilerContext {
  sorted: ClassifiedDAGStep[];
  contractsByStep: Map<string, DocumentContract>;
  conditionalsByStep: Map<string, Conditional>;
  conditionalBranchTargets: Set<string>;
  warnings: CompileWarning[];
}

/** Build all lookup indexes for a job's DAG. */
function buildContext(job: ClassifiedJobWithDAG, sorted: ClassifiedDAGStep[]): CompilerContext {
  const contractsByStep = new Map(job.documentContracts.map((c) => [c.producerStepId, c]));
  const conditionalsByStep = new Map((job.conditionals ?? []).map((c) => [c.stepId, c]));

  const warnings: CompileWarning[] = [];
  for (const step of job.steps) {
    if (!contractsByStep.has(step.id)) {
      warnings.push({
        type: "no_output_contract",
        stepId: step.id,
        agentId: step.agentId,
        message: `Step "${step.id}" (agent: ${step.agentId}) has no documentContract — output won't be tracked`,
      });
    }
  }

  const conditionalBranchTargets = new Set<string>();
  for (const conditional of job.conditionals ?? []) {
    for (const branch of conditional.branches) {
      conditionalBranchTargets.add(branch.targetStep);
    }
  }

  return { sorted, contractsByStep, conditionalsByStep, conditionalBranchTargets, warnings };
}

/**
 * Compile a ClassifiedJobWithDAG into an FSMDefinition.
 *
 * All steps emit `agentAction(step.agentId)` — the runtime expansion layer
 * resolves execution details (provider, model, tools) at load time.
 *
 * @param job - A classified job with typed DAG steps, document contracts, prepare mappings, and optional conditionals
 * @returns Result with FSMDefinition on success, or array of errors on failure
 */
export function buildFSMFromPlan(job: ClassifiedJobWithDAG): CompilerResult {
  const sortResult = topologicalSort(job.steps);
  if (!sortResult.success) return sortResult;

  const sorted = sortResult.value;
  const firstStep = sorted[0];
  if (!firstStep) {
    return {
      success: false,
      error: [{ type: "no_root_steps", message: "Topological sort produced no steps" }],
    };
  }

  const ctx = buildContext(job, sorted);
  const builder = new FSMBuilder(job.id);

  builder
    .setInitialState("idle")
    .addState("idle")
    .onTransition(job.triggerSignalId, stateName(firstStep.id));

  buildStates(builder, ctx);

  builder.addState("completed").final();
  for (const contract of job.documentContracts) {
    builder.addDocumentType(contract.documentType, contract.schema);
  }

  const result = builder.build();
  if (!result.success) return result;

  return { success: true, value: { fsm: result.value, warnings: ctx.warnings } };
}

/** Add one FSM state per DAG step: entry actions, transitions, and guards. */
function buildStates(builder: FSMBuilder, ctx: CompilerContext): void {
  const registeredGuards = new Set<string>();

  for (let i = 0; i < ctx.sorted.length; i++) {
    const step = ctx.sorted[i];
    if (!step) continue;

    const nextState = resolveNextState(ctx.sorted, i, ctx.conditionalBranchTargets);
    builder.addState(stateName(step.id));

    // Execution action + emit ADVANCE
    const contract = ctx.contractsByStep.get(step.id);
    builder.onEntry(
      agentAction(step.agentId, {
        outputTo: contract?.documentId,
        outputType: contract?.documentType,
        prompt: step.description,
      }),
    );
    builder.onEntry(emitAction("ADVANCE"));

    // Transition: conditional branches, fan-in guard, existence guard, or unconditional
    const conditional = ctx.conditionalsByStep.get(step.id);
    const nextStep = i < ctx.sorted.length - 1 ? ctx.sorted[i + 1] : undefined;

    if (conditional) {
      addConditionalTransitions(builder, step, conditional, contract);
    } else if (nextStep && nextStep.depends_on.length > 1) {
      const guardName = `guard_fan_in_${normalize(nextStep.id)}`;
      const upstreamDocIds = nextStep.depends_on
        .map((id) => ctx.contractsByStep.get(id)?.documentId)
        .filter((id): id is string => id !== undefined);
      builder.onTransition("ADVANCE", nextState).withGuard(guardName);
      if (!registeredGuards.has(guardName)) {
        builder.addFunction(guardName, "guard", fanInGuardCode(guardName, upstreamDocIds));
        registeredGuards.add(guardName);
      }
    } else if (contract) {
      const guardName = `guard_${normalize(step.id)}_done`;
      builder.onTransition("ADVANCE", nextState).withGuard(guardName);
      builder.addFunction(guardName, "guard", existenceGuardCode(guardName, contract.documentId));
    } else {
      builder.onTransition("ADVANCE", nextState);
    }
  }
}

/** Wire conditional branches as a transition array through the builder. */
function addConditionalTransitions(
  builder: FSMBuilder,
  step: ClassifiedDAGStep,
  conditional: Conditional,
  contract: DocumentContract | undefined,
): void {
  const docId = contract?.documentId ?? step.id;

  const transitions: Array<{ target: string; guards: string[] }> = [];
  for (const branch of conditional.branches) {
    const target = stateName(branch.targetStep);
    const guardName = branch.default
      ? `guard_cond_default_${normalize(step.id)}`
      : `guard_cond_${normalize(step.id)}_${normalize(branch.targetStep)}`;

    const code = branch.default
      ? wrapFunction(guardName, "  return true;")
      : conditionalGuardCode(guardName, docId, conditional.field, branch.equals);

    builder.addFunction(guardName, "guard", code);
    transitions.push({ target, guards: [guardName] });
  }

  builder.onTransitions("ADVANCE", transitions);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the next FSM state for a step at `index` in the sorted DAG.
 *
 * Branch targets skip over sibling branches to the convergence point.
 * Normal steps chain to the next step in topological order.
 */
function resolveNextState(
  sorted: ClassifiedDAGStep[],
  index: number,
  conditionalBranchTargets: Set<string>,
): string {
  const step = sorted[index];
  if (!step) return "completed";

  if (conditionalBranchTargets.has(step.id)) {
    let j = index + 1;
    while (j < sorted.length) {
      const candidate = sorted[j];
      if (!candidate || !conditionalBranchTargets.has(candidate.id)) break;
      j++;
    }
    const convergenceStep = sorted[j];
    return convergenceStep ? stateName(convergenceStep.id) : "completed";
  }

  const nextStep = sorted[index + 1];
  return nextStep ? stateName(nextStep.id) : "completed";
}

export function stateName(stepId: string): string {
  return `step_${normalize(stepId)}`;
}

export function normalize(id: string): string {
  return id.replace(/-/g, "_");
}

// ---------------------------------------------------------------------------
// Template code generators
// ---------------------------------------------------------------------------

function wrapFunction(name: string, body: string): string {
  return `export default function ${name}(context, event) {\n${body}\n}`;
}

function existenceGuardCode(guardName: string, docId: string): string {
  return wrapFunction(guardName, `  return context.results['${docId}'] !== undefined;`);
}

function fanInGuardCode(guardName: string, docIds: string[]): string {
  const checks = docIds.map((id) => `context.results['${id}'] !== undefined`);
  return wrapFunction(guardName, `  return ${checks.join(" && ")};`);
}

function conditionalGuardCode(
  guardName: string,
  docId: string,
  field: string,
  value: unknown,
): string {
  const jsonValue = JSON.stringify(value);
  return wrapFunction(
    guardName,
    `  return context.results['${docId}']?.${field} === ${jsonValue};`,
  );
}

// ---------------------------------------------------------------------------
// Warning formatting
// ---------------------------------------------------------------------------

/**
 * Format compiler warnings into readable grouped-by-job output.
 *
 * @param jobWarnings - Array of { jobId, warnings } from compilation
 * @returns Formatted string, or empty string if no warnings
 */
export function formatCompilerWarnings(
  jobWarnings: Array<{ jobId: string; warnings: CompileWarning[] }>,
): string {
  const count = jobWarnings.reduce((n, jw) => n + jw.warnings.length, 0);
  if (count === 0) return "";

  const lines: string[] = [`Compilation warnings (${count}):`];

  for (const { jobId, warnings: ws } of jobWarnings) {
    if (ws.length === 0) continue;
    lines.push("");
    lines.push(`  job "${jobId}":`);
    for (const w of ws) {
      lines.push(
        `    step "${w.stepId}" (agent: ${w.agentId}): no output contract — output won't be tracked`,
      );
    }
  }

  return lines.join("\n");
}
