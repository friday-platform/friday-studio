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
  ArtifactRevisionSummary,
  ArtifactSummary,
  ArtifactType,
  ArtifactWithContents,
  CreateArtifactInput,
  ResourceIndexEntry,
} from "./model.ts";
export {
  ArtifactDataInputSchema,
  ArtifactDataSchema,
  ArtifactSchema,
  ArtifactSummarySchema,
  ArtifactTypeSchema,
  CreateArtifactSchema,
  ResourceIndexEntrySchema,
  UpdateArtifactSchema,
} from "./model.ts";

// Primitives
export type { FileData, FileDataInput } from "./primitives.ts";
export { FileDataInputSchema, FileDataSchema } from "./primitives.ts";

// Storage adapter types
export type { ArtifactStorageAdapter } from "./types.ts";
