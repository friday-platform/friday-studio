import { z } from "zod";
import {
  CalendarScheduleSchema,
  SlackSummaryDataSchema,
  SummaryDataSchema,
  WorkspacePlanSchema,
} from "./primitives.ts";

/** Revision summary for history */
export interface ArtifactRevisionSummary {
  revision: number;
  createdAt: string;
  revisionMessage?: string;
}

const WorkspacePlanArtifactSchema = z.object({
  type: z.literal("workspace-plan"),
  version: z.literal(1),
  data: WorkspacePlanSchema,
});

const CalendarScheduleArtifactSchema = z.object({
  type: z.literal("calendar-schedule"),
  version: z.literal(1),
  data: CalendarScheduleSchema,
});

const SummaryArtifactSchema = z.object({
  type: z.literal("summary"),
  version: z.literal(1),
  data: SummaryDataSchema,
});

const SlackSummaryArtifactSchema = z.object({
  type: z.literal("slack-summary"),
  version: z.literal(1),
  data: SlackSummaryDataSchema,
});

/** Artifact data validation by type */
export const ArtifactDataSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifactSchema,
  CalendarScheduleArtifactSchema,
  SummaryArtifactSchema,
  SlackSummaryArtifactSchema,
  // Add future schemas here
]);

/** Extract the artifact type union */
export type ArtifactType = z.infer<typeof ArtifactDataSchema>["type"];
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

/** Schema for valid artifact types - using enum for single type support */
export const ArtifactTypeSchema = z.enum([
  "workspace-plan",
  "calendar-schedule",
  "summary",
  "slack-summary",
]);

/** Shared request schemas for REST and MCP */
export const CreateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataSchema, // Validated separately by ArtifactDataSchema
  summary: z.string().min(10).max(500),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export const UpdateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataSchema,
  summary: z.string().min(10).max(500),
  revisionMessage: z.string().optional(),
});

/** Artifact entity (immutable - updates create revisions) */
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  revision: z.number(),
  data: ArtifactDataSchema,
  summary: z.string(),
  createdAt: z.iso.datetime(),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  revisionMessage: z.string().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
