/**
 * @atlas/workspace-builder
 *
 * Planner pipeline, deterministic compiler, and assembler for workspace blueprints.
 * Also exposes the FSMBuilder fluent API for direct FSM construction.
 */

// ---------------------------------------------------------------------------
// Planner pipeline
// ---------------------------------------------------------------------------

export type {
  BlueprintResult,
  BuildBlueprintOpts,
} from "./planner/build-blueprint.ts";
export { buildBlueprint, PipelineError } from "./planner/build-blueprint.ts";

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export type { CompileError, CompilerOutput, CompileWarning } from "./compiler/build-fsm.ts";
export { buildFSMFromPlan, formatCompilerWarnings } from "./compiler/build-fsm.ts";

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export { buildWorkspaceYaml } from "./assembler/build-workspace.ts";

// ---------------------------------------------------------------------------
// FSMBuilder fluent API
// ---------------------------------------------------------------------------

export { FSMBuilder } from "./builder.ts";
export {
  agentAction,
  codeAction,
  emitAction,
  llmAction,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Blueprint types
// ---------------------------------------------------------------------------

export type { ClassifiedJobWithDAG } from "./planner/stamp-execution-types.ts";
export type {
  Agent,
  ClassifiedDAGStep,
  Conditional,
  CredentialBinding,
  DAGStep,
  DocumentContract,
  JobWithDAG,
  PrepareMapping,
  Signal,
  WorkspaceBlueprint,
} from "./types.ts";
export {
  ClassifiedDAGStepSchema,
  CredentialBindingSchema,
  WorkspaceBlueprintSchema,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Planner result types (re-exported from internal modules)
// ---------------------------------------------------------------------------

export type { ReadinessResult, UnresolvedCredential } from "./planner/build-blueprint.ts";
export type { AgentClarification } from "./planner/classify-agents.ts";
export { formatClarifications } from "./planner/classify-agents.ts";
export { generateStubFromSchema } from "./planner/generate-stub.ts";

// ---------------------------------------------------------------------------
// FSMBuilder types
// ---------------------------------------------------------------------------

export type {
  Action,
  BuildError,
  BuildErrorType,
  FSMDefinition,
  FunctionConfig,
  JSONSchema,
  Result,
  StateConfig,
  TransitionConfig,
} from "./types.ts";
