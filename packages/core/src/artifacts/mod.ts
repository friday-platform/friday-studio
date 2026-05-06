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
// Tool-result scrubber (lifts oversized binary out of MCP results into artifacts).
export type { ScrubberOptions, ScrubToolResult } from "./scrubber.ts";
export { createScrubber, scrubAssistantMessage } from "./scrubber.ts";
// Storage adapter types
export type { ArtifactStorageAdapter } from "./types.ts";
