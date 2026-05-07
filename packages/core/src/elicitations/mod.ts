// Domain model

// JetStream adapter (exposed for direct use in migrations/tests)
export { JetStreamElicitationStorageAdapter } from "./jetstream-adapter.ts";
export type {
  CreateElicitationInput,
  Elicitation,
  ElicitationAnswer,
  ElicitationKind,
  ElicitationOption,
  ElicitationPendingTool,
  ElicitationStatus,
} from "./model.ts";
export {
  CreateElicitationSchema,
  ElicitationAnswerSchema,
  ElicitationKindSchema,
  ElicitationOptionSchema,
  ElicitationPendingToolSchema,
  ElicitationSchema,
  ElicitationStatusSchema,
} from "./model.ts";
// Storage facade + initializer
export {
  ElicitationStorage,
  initElicitationStorage,
  resetElicitationStorageForTests,
} from "./storage.ts";

// Adapter interface
export type { ElicitationStorageAdapter, ExpireSweepResult } from "./types.ts";
