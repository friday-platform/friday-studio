import { z } from "zod";

/** Revision summary for history */
export interface ArtifactRevisionSummary {
  revision: number;
  createdAt: Date;
  revisionMessage?: string;
}

/** Workspace plan data schema */
export const WorkspacePlanDataSchema = z.object({});

/** Calendar schedule data schema */
export const CalendarScheduleDataSchema = z.object({
  events: z.array(
    z.object({
      eventName: z.string().describe("Name of the event"),
      startDate: z.coerce.date().describe("Start date of the event (ISO 8601 accepted)"),
      endDate: z.coerce.date().describe("End date of the event (ISO 8601 accepted)"),
    }),
  ),
  source: z.string().describe("Source of the schedule (eg. Google Calendar, iCal, etc.)"),
  sourceUrl: z
    .string()
    .optional()
    .describe("URL of the source of the schedule (eg. Google Calendar URL, iCal URL, etc.)"),
});

/** Individual artifact type schemas */
const WorkspacePlanArtifactSchema = z.object({
  type: z.literal("workspace-plan"),
  version: z.literal(1),
  data: WorkspacePlanDataSchema,
});

export const CalendarScheduleArtifactSchema = z.object({
  type: z.literal("calendar-schedule"),
  version: z.literal(1),
  data: CalendarScheduleDataSchema,
});

/** Artifact data validation by type */
export const ArtifactDataSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifactSchema,
  CalendarScheduleArtifactSchema,
  // Add future schemas here
]);

/** Extract the artifact type union */
export type ArtifactType = z.infer<typeof ArtifactDataSchema>["type"];
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;
export type WorkspacePlanData = z.infer<typeof WorkspacePlanDataSchema>;

/** Schema for valid artifact types - using enum for single type support */
export const ArtifactTypeSchema = z.enum(["workspace-plan", "calendar-schedule"]);

/** Shared request schemas for REST and MCP */
export const CreateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataSchema, // Validated separately by ArtifactDataSchema
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export const UpdateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataSchema,
  revisionMessage: z.string().optional(),
});

/** Artifact entity (immutable - updates create revisions) */
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  revision: z.number(),
  data: ArtifactDataSchema,
  createdAt: z.coerce.date(),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  revisionMessage: z.string().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
