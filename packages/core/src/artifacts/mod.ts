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
  ArtifactSchema,
  ArtifactSummarySchema,
  ArtifactTypeSchema,
  CreateArtifactSchema,
  CreateArtifactWireSchema,
  ResourceIndexEntrySchema,
  UpdateArtifactSchema,
  UpdateArtifactWireSchema,
} from "./model.ts";

// Primitives
export type { FileData, FileDataInput, FileDataInputWire } from "./primitives.ts";
export { FileDataInputSchema, FileDataInputWireSchema, FileDataSchema } from "./primitives.ts";

// Storage adapter types
export type { ArtifactStorageAdapter } from "./types.ts";
