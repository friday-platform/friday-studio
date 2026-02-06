import { z } from "zod";

/** Name validation per Agent Skills spec */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Name must be lowercase alphanumeric with single hyphens, no leading/trailing hyphens",
  });

export const CreateSkillInputSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  instructions: z.string().min(1),
  workspaceId: z.string().min(1),
});

/** Input for creating a skill (from approved draft) */
export type CreateSkillInput = z.infer<typeof CreateSkillInputSchema>;

export const SkillSchema = CreateSkillInputSchema.extend({
  id: z.string(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** Stored skill entity */
export type Skill = z.infer<typeof SkillSchema>;

export const SkillSummarySchema = z.object({ name: SkillNameSchema, description: z.string() });

/** Lightweight summary for listing */
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** Schema for parsing database rows with snake_case columns */
export const SkillDbRowSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  instructions: z.string(),
  workspace_id: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
