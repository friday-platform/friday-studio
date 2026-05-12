// HTML rendering utilities
export { escapeHTML, renderWorkspacePlanHTML } from "./html.ts";
// JSON Schema validation
export type { ValidatedJSONSchema } from "./json-schema.ts";
export { JSONSchemaSchema } from "./json-schema.ts";
// Domain model
export type {
  Artifact,
  ArtifactData,
  ArtifactDataInput,
  ArtifactDataInputWire,
  ArtifactLifecycle,
  ArtifactRevisionSummary,
  ArtifactSummary,
  ArtifactType,
  ArtifactWithContents,
  CreateArtifactInput,
  ResourceIndexEntry,
} from "./model.ts";
export {
  ArtifactDataInputSchema,
  ArtifactDataInputWireSchema,
  ArtifactDataSchema,
  ArtifactLifecycleSchema,
  ArtifactSchema,
  ArtifactSummarySchema,
  ArtifactTypeSchema,
  CreateArtifactSchema,
  ResourceIndexEntrySchema,
  UpdateArtifactSchema,
} from "./model.ts";

// Primitives
export type {
  FileData,
  FileDataInput,
  FileDataInputWire,
} from "./primitives.ts";
export {
  FileDataInputSchema,
  FileDataInputWireSchema,
  FileDataSchema,
} from "./primitives.ts";
// NOTE: hasPromotionSignal lives in `./server.ts` — the Phase 6.B sweeper
// (atlasd-internal) is the only consumer and uses the server-only path.
// Tool-result scrubber: lifts oversized inline binary / large text out of
// tool results into artifacts. Two entry points — `liftToolResultsForPersist`
// at the persistence boundary, `scrubAssistantMessage` at chat pre-persist.
export type { ScrubberOptions } from "./scrubber.ts";
export {
  liftToolResultsForPersist,
  liftValueForModel,
  scrubAssistantMessage,
} from "./scrubber.ts";
// Storage adapter types
export type { ArtifactStorageAdapter } from "./types.ts";
