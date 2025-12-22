/**
 * @atlas/workspace-builder
 *
 * Fluent API for building FSM definitions
 */

// Core builder
export { FSMBuilder } from "./builder.ts";

// Helper functions
export {
  agentAction,
  codeAction,
  emitAction,
  llmAction,
} from "./helpers.ts";
// Codegen execution (direct function call)
export { executeCodegen } from "./mcp-tools/codegen.ts";
// Types
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
