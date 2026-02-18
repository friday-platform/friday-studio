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

import type { FSMDefinition } from "../../fsm-engine/types.ts";
import { FSMBuilder } from "../builder.ts";
import { agentAction, codeAction, emitAction, llmAction } from "../helpers.ts";
import type { ClassifiedJobWithDAG } from "../planner/stamp-execution-types.ts";
import { type TopologicalSortError, topologicalSort } from "../topological-sort.ts";
import type {
  BuildError,
  ClassifiedDAGStep,
  Conditional,
  DocumentContract,
  PrepareMapping,
  Result,
} from "../types.ts";
import { SIGNAL_DOCUMENT_ID } from "../types.ts";
import { validateFieldPath } from "./validate-field-path.ts";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default LLM provider for ad-hoc LLM agents. */
const DEFAULT_LLM_PROVIDER = "anthropic";

/** Default LLM model for ad-hoc LLM agents. */
const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Error specific to plan compilation (distinct from FSMBuilder's BuildError) */
export type { TopologicalSortError as CompileError } from "../topological-sort.ts";

/** Non-fatal issue detected during compilation */
export type CompileWarning = NoOutputContractWarning | InvalidPreparePathWarning;

interface NoOutputContractWarning {
  type: "no_output_contract";
  stepId: string;
  agentId: string;
  message: string;
}

interface InvalidPreparePathWarning {
  type: "invalid_prepare_path";
  stepId: string;
  documentId: string;
  path: string;
  available: string[];
  message: string;
}

export interface CompilerOutput {
  fsm: FSMDefinition;
  warnings: CompileWarning[];
}

type CompilerResult = Result<CompilerOutput, (TopologicalSortError | BuildError)[]>;

/** Pre-computed indexes and validation results for a single job compilation. */
export interface CompilerContext {
  sorted: ClassifiedDAGStep[];
  contractsByStep: Map<string, DocumentContract>;
  contractsByDocId: Map<string, DocumentContract>;
  mappingsByStep: Map<string, PrepareMapping[]>;
  conditionalsByStep: Map<string, Conditional>;
  conditionalBranchTargets: Set<string>;
  invalidPaths: Set<string>;
  warnings: CompileWarning[];
}

/** Build all lookup indexes and validate field paths for a job's DAG. */
function buildContext(job: ClassifiedJobWithDAG, sorted: ClassifiedDAGStep[]): CompilerContext {
  const contractsByStep = new Map(job.documentContracts.map((c) => [c.producerStepId, c]));
  const mappingsByStep = new Map<string, PrepareMapping[]>();
  for (const m of job.prepareMappings) {
    const list = mappingsByStep.get(m.consumerStepId) ?? [];
    list.push(m);
    mappingsByStep.set(m.consumerStepId, list);
  }
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

  // Invalid paths are dropped from generated code; warnings still emitted.
  const contractsByDocId = new Map<string, DocumentContract>(
    job.documentContracts.map((c) => [c.documentId, c]),
  );
  const invalidPaths = new Set<string>(); // key: `${consumerStepId}:${documentId}:${from}`
  for (const mapping of job.prepareMappings) {
    const contract = contractsByDocId.get(mapping.documentId);
    if (!contract) continue;

    for (const source of mapping.sources) {
      const result = validateFieldPath(contract.schema, source.from);
      if (!result.valid) {
        invalidPaths.add(`${mapping.consumerStepId}:${mapping.documentId}:${source.from}`);
        warnings.push({
          type: "invalid_prepare_path",
          stepId: mapping.consumerStepId,
          documentId: mapping.documentId,
          path: source.from,
          available: result.available,
          message: `Step "${mapping.consumerStepId}" mapping references "${source.from}" in document "${mapping.documentId}" — path not found in schema. Available: ${result.available.join(", ")}`,
        });
      }
    }
  }

  // Branch target steps skip over sibling branches, not chain sequentially.
  const conditionalBranchTargets = new Set<string>();
  for (const conditional of job.conditionals ?? []) {
    for (const branch of conditional.branches) {
      conditionalBranchTargets.add(branch.targetStep);
    }
  }

  return {
    sorted,
    contractsByStep,
    contractsByDocId,
    mappingsByStep,
    conditionalsByStep,
    conditionalBranchTargets,
    invalidPaths,
    warnings,
  };
}

/**
 * Compile a ClassifiedJobWithDAG into an FSMDefinition.
 *
 * Steps with `executionType: "bundled"` emit `agentAction()`, steps with
 * `executionType: "llm"` emit `llmAction()` with default provider/model.
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
    .onEntry(codeAction("cleanup"))
    .onTransition(job.triggerSignalId, stateName(firstStep.id));
  builder.addFunction("cleanup", "action", CLEANUP_CODE);

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

    // Prepare mappings (filter invalid paths, deduplicate array projections)
    const rawMappings = ctx.mappingsByStep.get(step.id) ?? [];
    const filteredMappings = rawMappings
      .map((m) => ({
        ...m,
        sources: deduplicateSources(
          m.sources.filter((s) => !ctx.invalidPaths.has(`${step.id}:${m.documentId}:${s.from}`)),
        ),
      }))
      .filter((m) => m.sources.length > 0 || m.constants.length > 0);

    if (filteredMappings.length > 0) {
      const prepareFn = `prepare_${normalize(step.id)}`;
      builder.onEntry(codeAction(prepareFn));
      builder.addFunction(
        prepareFn,
        "action",
        prepareCode(step.id, step.description, filteredMappings, ctx.contractsByDocId),
      );
    }

    // Execution action + emit ADVANCE
    const contract = ctx.contractsByStep.get(step.id);
    if (step.executionType === "bundled") {
      builder.onEntry(
        agentAction(step.agentId, {
          outputTo: contract?.documentId,
          outputType: contract?.documentType,
          prompt: step.description,
        }),
      );
    } else {
      builder.onEntry(
        llmAction({
          provider: DEFAULT_LLM_PROVIDER,
          model: DEFAULT_LLM_MODEL,
          prompt: step.description,
          tools: step.tools,
          outputTo: contract?.documentId,
          outputType: contract?.documentType,
        }),
      );
    }
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
 * Remove redundant array element projections when the full array is already mapped.
 *
 * If sources contain both `items` (full array) and `items[].name`, `items[].price`, etc.,
 * the element projections are redundant — the full array already carries all fields.
 * This drops the child paths to avoid duplicate data in the prepared config.
 */
function deduplicateSources(
  sources: Array<{ from: string; to: string; transform?: string; description?: string }>,
): Array<{ from: string; to: string; transform?: string; description?: string }> {
  // Collect all "from" paths that are full-array parents (no bracket notation)
  const parentPaths = new Set(sources.filter((s) => !s.from.includes("[]")).map((s) => s.from));

  // Drop sources whose fromPath is `parent[].child` when `parent` is already mapped
  return sources.filter((s) => {
    const bracketIdx = s.from.indexOf("[]");
    if (bracketIdx === -1) return true; // not an element projection
    const parent = s.from.slice(0, bracketIdx);
    return !parentPaths.has(parent);
  });
}

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

function stateName(stepId: string): string {
  return `step_${normalize(stepId)}`;
}

function normalize(id: string): string {
  return id.replace(/-/g, "_");
}

// ---------------------------------------------------------------------------
// Template code generators
// ---------------------------------------------------------------------------

function wrapFunction(name: string, body: string): string {
  return `export default function ${name}(context, event) {\n${body}\n}`;
}

const CLEANUP_CODE = wrapFunction("cleanup", "  // Delete known documents from previous run");

/**
 * Convert a dot-path (potentially with `[]` array notation) to valid JS.
 *
 * Simple paths chain with optional access:
 *   `("base", "summary")` → `base?.summary`
 *
 * Array paths use `.map()` over remaining segments:
 *   `("base", "products[].brand")` → `base?.products?.map(v => v?.brand)`
 *
 * Nested arrays use `.flatMap()` for intermediate arrays:
 *   `("base", "items[].queries[].sql")` → `base?.items?.flatMap(v => v?.queries?.map(v2 => v2?.sql))`
 */
function fieldPathToJS(base: string, fieldPath: string, depth = 0): string {
  const segments = fieldPath.split(".");
  let expr = base;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const bracketMatch = seg.match(/^(.+)\[\]$/);

    if (bracketMatch) {
      expr += `?.${bracketMatch[1]}`;
      const remaining = segments.slice(i + 1);
      if (remaining.length === 0) break;
      const innerPath = remaining.join(".");
      const varName = depth === 0 ? "v" : `v${depth + 1}`;
      const method = innerPath.includes("[]") ? "flatMap" : "map";
      return `${expr}?.${method}(${varName} => ${fieldPathToJS(varName, innerPath, depth + 1)})`;
    }

    expr += `?.${seg}`;
  }

  return expr;
}

function prepareCode(
  stepId: string,
  description: string,
  mappings: Array<{
    documentId: string;
    sources: Array<{ from: string; to: string; transform?: string; description?: string }>;
    constants: Array<{ key: string; value: unknown }>;
  }>,
  contractsByDocId?: Map<string, DocumentContract>,
): string {
  const lines: string[] = ["  const config = {};"];

  if (mappings.some((m) => m.sources.some((s) => s.transform))) {
    lines.push("  const docs = context.results;");
  }

  for (const mapping of mappings) {
    const isSignal = mapping.documentId === SIGNAL_DOCUMENT_ID;
    const resultsBase = isSignal ? "event.data" : `context.results['${mapping.documentId}']`;

    for (const source of mapping.sources) {
      if (source.transform) {
        const topField = source.from.split(".")[0] ?? source.from;
        const contract = contractsByDocId?.get(mapping.documentId);
        const required = contract?.schema?.required;
        const isRequired = Array.isArray(required) && required.includes(topField);

        lines.push(`  config['${source.to}'] = (() => {`);
        lines.push(`    const value = ${fieldPathToJS(resultsBase, source.from)};`);
        if (isRequired) {
          lines.push(
            `    if (value === undefined) throw new Error("Source field '${source.from}' not found in '${mapping.documentId}'");`,
          );
        } else {
          lines.push(`    if (value === undefined) return undefined;`);
        }
        lines.push(`    return ${source.transform};`);
        lines.push("  })();");
      } else {
        lines.push(`  config['${source.to}'] = ${fieldPathToJS(resultsBase, source.from)};`);
      }
    }

    for (const constant of mapping.constants) {
      lines.push(`  config['${constant.key}'] = ${JSON.stringify(constant.value)};`);
    }
  }

  const escapedDesc = description.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  lines.push(`  return { task: '${escapedDesc}', config };`);
  return wrapFunction(`prepare_${normalize(stepId)}`, lines.join("\n"));
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
      if (w.type === "no_output_contract") {
        lines.push(
          `    step "${w.stepId}" (agent: ${w.agentId}): no output contract — output won't be tracked`,
        );
      } else {
        lines.push(
          `    step "${w.stepId}": invalid prepare path "${w.path}" in ${w.documentId} — source skipped`,
        );
      }
    }
  }

  return lines.join("\n");
}
