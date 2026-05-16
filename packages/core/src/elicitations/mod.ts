// Domain model

// Shared `workspace-setup` emit helper — used by the import-time bootstrap
// spawn and the chat-side `request_workspace_setup` tool so both call sites
// produce the same envelope.
export {
  type EmitWorkspaceSetupElicitationArgs,
  emitWorkspaceSetupElicitation,
} from "./emit-workspace-setup.ts";
// JetStream adapter (exposed for direct use in migrations/tests).
// `bootstrapElicitationsStream` is the single source of truth for
// stream config — called by the bootstrap migration in production and
// by `vitest.setup.ts` in tests.
export {
  bootstrapElicitationsStream,
  JetStreamElicitationStorageAdapter,
} from "./jetstream-adapter.ts";
export type {
  CreateElicitationInput,
  Elicitation,
  ElicitationAnswer,
  ElicitationKind,
  ElicitationOption,
  ElicitationPendingTool,
  ElicitationStatus,
  SetupRequirement,
  WorkspaceSetupAnswerValue,
} from "./model.ts";
export {
  CreateElicitationSchema,
  ElicitationAnswerSchema,
  ElicitationKindSchema,
  ElicitationOptionSchema,
  ElicitationPendingToolSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
  SetupRequirementSchema,
  WorkspaceSetupAnswerValueSchema,
} from "./model.ts";
// Storage facade + initializer
export {
  ElicitationStorage,
  initElicitationStorage,
  resetElicitationStorageForTests,
} from "./storage.ts";
export type { ToolAccessGrant } from "./tool-access-grants.ts";
export {
  bootstrapToolAccessGrantStorage,
  initToolAccessGrantStorage,
  JetStreamToolAccessGrantAdapter,
  resetToolAccessGrantStorageForTests,
  ToolAccessGrantSchema,
  ToolAccessGrants,
} from "./tool-access-grants.ts";

// Adapter interface
export type { ElicitationStorageAdapter, ExpireSweepResult } from "./types.ts";
