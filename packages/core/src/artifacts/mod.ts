// Domain model
export type {
  Artifact,
  ArtifactData,
  ArtifactRevisionSummary,
  ArtifactType,
  WorkspacePlanData,
} from "./model.ts";

export {
  ArtifactDataSchema,
  ArtifactTypeSchema,
  CreateArtifactSchema,
  UpdateArtifactSchema,
  WorkspacePlanDataSchema,
} from "./model.ts";

// Storage operations
export { ArtifactStorage } from "./storage.ts";
