import { z } from "zod";

/** Artifact entity (immutable - updates create revisions) */
export interface Artifact {
  id: string;
  type: string;
  revision: number;
  data: unknown;
  workspaceId?: string;
  chatId?: string;
  createdAt: Date;
  revisionMessage?: string;
}

/** Revision summary for history */
export interface ArtifactRevisionSummary {
  revision: number;
  createdAt: Date;
  revisionMessage?: string;
}

/** Workspace plan data schema */
export const WorkspacePlanDataSchema = z.object({});

/** Individual artifact type schemas */
const WorkspacePlanArtifactSchema = z.object({
  type: z.literal("workspace-plan"),
  version: z.literal(1),
  data: WorkspacePlanDataSchema,
});

/** Artifact data validation by type */
export const ArtifactDataSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifactSchema,
  // Add future schemas here
]);

/** Extract the artifact type union */
export type ArtifactType = z.infer<typeof ArtifactDataSchema>["type"];
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;
export type WorkspacePlanData = z.infer<typeof WorkspacePlanDataSchema>;

/** Schema for valid artifact types - using enum for single type support */
export const ArtifactTypeSchema = z.enum(["workspace-plan"]);

/** Shared request schemas for REST and MCP */
export const CreateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: z.unknown(), // Validated separately by ArtifactDataSchema
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export const UpdateArtifactSchema = z.object({
  data: z.unknown(),
  revisionMessage: z.string().optional(),
});
