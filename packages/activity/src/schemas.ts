import { z } from "zod";

// ==============================================================================
// ACTIVITY ENTITY
// ==============================================================================

export const ActivityTypeSchema = z.enum(["session", "resource"]);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const ActivitySourceSchema = z.enum(["agent", "user"]);
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;

export const ActivitySchema = z.object({
  id: z.string(),
  type: ActivityTypeSchema,
  source: ActivitySourceSchema,
  referenceId: z.string(),
  workspaceId: z.string(),
  jobId: z.string().nullable(),
  userId: z.string().nullable(),
  title: z.string(),
  createdAt: z.string(),
});

export type Activity = z.infer<typeof ActivitySchema>;

// ==============================================================================
// READ STATUS
// ==============================================================================

export const ReadStatusValueSchema = z.enum(["viewed", "dismissed"]);
export type ReadStatusValue = z.infer<typeof ReadStatusValueSchema>;

export const ActivityReadStatusSchema = z.object({
  userId: z.string(),
  activityId: z.string(),
  status: ReadStatusValueSchema,
});

export type ActivityReadStatus = z.infer<typeof ActivityReadStatusSchema>;

// ==============================================================================
// CREATE INPUT
// ==============================================================================

export const CreateActivityInputSchema = z.object({
  type: ActivityTypeSchema,
  source: ActivitySourceSchema,
  referenceId: z.string(),
  workspaceId: z.string(),
  jobId: z.string().nullable(),
  userId: z.string().nullable(),
  title: z.string(),
});

export type CreateActivityInput = z.infer<typeof CreateActivityInputSchema>;

// ==============================================================================
// LIST FILTER
// ==============================================================================

export const ActivityListFilterSchema = z.object({
  type: ActivityTypeSchema.optional(),
  workspaceId: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ActivityListFilter = z.infer<typeof ActivityListFilterSchema>;

// ==============================================================================
// ACTIVITY WITH READ STATUS
// ==============================================================================

export const ActivityWithReadStatusSchema = ActivitySchema.extend({
  readStatus: ReadStatusValueSchema.nullable(),
});

export type ActivityWithReadStatus = z.infer<typeof ActivityWithReadStatusSchema>;

// ==============================================================================
// DB ROW SCHEMAS (snake_case for SQLite layer)
// ==============================================================================

const ActivityDbRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  source: z.string(),
  reference_id: z.string(),
  workspace_id: z.string(),
  job_id: z.string().nullable(),
  user_id: z.string().nullable(),
  title: z.string(),
  created_at: z.string(),
});

export const ActivityWithReadStatusDbRowSchema = ActivityDbRowSchema.extend({
  read_status: z.string().nullable(),
});
