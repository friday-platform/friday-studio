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
  BlueprintProgressEvent,
  BlueprintResult,
  BuildBlueprintOpts,
} from "./planner/build-blueprint.ts";
export { buildBlueprint, PipelineError } from "./planner/build-blueprint.ts";

// ---------------------------------------------------------------------------
// Planner step functions (used by fastpath to run steps independently)
// ---------------------------------------------------------------------------

export { classifyAgents } from "./planner/classify-agents.ts";
export type { Phase1Result } from "./planner/plan.ts";
export { generatePlan } from "./planner/plan.ts";
export { checkEnvironmentReadiness } from "./planner/preflight.ts";
export { resolveCredentials } from "./planner/resolve-credentials.ts";

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export type {
  CompileError,
  CompilerContext,
  CompilerOutput,
  CompileWarning,
} from "./compiler/build-fsm.ts";
export {
  buildFSMFromPlan,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  formatCompilerWarnings,
  normalize,
  stateName,
} from "./compiler/build-fsm.ts";

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export { buildWorkspaceYaml } from "./assembler/build-workspace.ts";

// ---------------------------------------------------------------------------
// Blueprint compiler (pure: blueprint → YAML)
// ---------------------------------------------------------------------------

export type { CompileBlueprintResult } from "./compile-blueprint.ts";
export { compileBlueprint } from "./compile-blueprint.ts";

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
export type { AgentClarification, ConfigRequirement } from "./planner/classify-agents.ts";
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
