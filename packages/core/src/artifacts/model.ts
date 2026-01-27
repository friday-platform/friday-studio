import { z } from "zod";
import {
  CalendarScheduleSchema,
  DatabaseDataSchema,
  FileDataInputSchema,
  FileDataSchema,
  SlackSummaryDataSchema,
  SummaryDataSchema,
  TableDataSchema,
  WebSearchDataSchema,
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

const FileArtifactSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataSchema,
});

const TableArtifactSchema = z.object({
  type: z.literal("table"),
  version: z.literal(1),
  data: TableDataSchema,
});

const WebSearchArtifactSchema = z.object({
  type: z.literal("web-search"),
  version: z.literal(1),
  data: WebSearchDataSchema,
});

const DatabaseArtifactSchema = z.object({
  type: z.literal("database"),
  version: z.literal(1),
  data: DatabaseDataSchema,
});

/** Artifact data schemas for storage (output) */
export const ArtifactDataSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifactSchema,
  CalendarScheduleArtifactSchema,
  SummaryArtifactSchema,
  SlackSummaryArtifactSchema,
  FileArtifactSchema,
  TableArtifactSchema,
  WebSearchArtifactSchema,
  DatabaseArtifactSchema,
]);

export type ArtifactType = z.infer<typeof ArtifactDataSchema>["type"];
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

/** Artifact data schemas for creation (input) */
const WorkspacePlanInputSchema = WorkspacePlanArtifactSchema;
const CalendarScheduleInputSchema = CalendarScheduleArtifactSchema;
const SummaryInputSchema = SummaryArtifactSchema;
const SlackSummaryInputSchema = SlackSummaryArtifactSchema;
const FileArtifactInputSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataInputSchema,
});
const TableInputSchema = TableArtifactSchema;
const WebSearchInputSchema = WebSearchArtifactSchema;
const DatabaseInputSchema = DatabaseArtifactSchema;

export const ArtifactDataInputSchema = z.discriminatedUnion("type", [
  WorkspacePlanInputSchema,
  CalendarScheduleInputSchema,
  SummaryInputSchema,
  SlackSummaryInputSchema,
  FileArtifactInputSchema,
  TableInputSchema,
  WebSearchInputSchema,
  DatabaseInputSchema,
]);

export type ArtifactDataInput = z.infer<typeof ArtifactDataInputSchema>;

/** Schema for valid artifact types - using enum for single type support */
export const ArtifactTypeSchema = z.enum([
  "workspace-plan",
  "calendar-schedule",
  "summary",
  "slack-summary",
  "file",
  "table",
  "web-search",
  "database",
]);

/** Shared request schemas for REST and MCP */

// Single unified schema for all artifact types (uses input schemas)
// For file artifacts, mimeType will be auto-detected by storage layer
export const CreateArtifactSchema = z.object({
  data: ArtifactDataInputSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(5000),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export type CreateArtifactInput = z.infer<typeof CreateArtifactSchema>;

export const UpdateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataInputSchema,
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(5000),
  revisionMessage: z.string().optional(),
});

/** Artifact entity (immutable - updates create revisions) */
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  revision: z.number(),
  data: ArtifactDataSchema,
  title: z.string(),
  summary: z.string(),
  createdAt: z.iso.datetime(),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  revisionMessage: z.string().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Artifact with optional contents loaded.
 * Used when artifact file contents have been fetched alongside metadata.
 */
export type ArtifactWithContents = Artifact & { contents?: string };
