import { NamespaceSchema, noXmlTags, noXmlTagsMessage, SkillNameSchema } from "@atlas/config";
import { z } from "zod";

export { SkillNameSchema };

// ==============================================================================
// PUBLISH INPUT
// ==============================================================================

/** Input for publishing a new version of a skill (namespace/name come from method params) */
export const PublishSkillInputSchema = z.object({
  description: z.string().max(1024).refine(noXmlTags, { message: noXmlTagsMessage }).optional(),
  instructions: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  archive: z.instanceof(Uint8Array).optional(),
  skillId: z.string().optional(),
  descriptionManual: z.boolean().optional(),
});

export type PublishSkillInput = z.infer<typeof PublishSkillInputSchema>;

// ==============================================================================
// STORED SKILL ENTITY
// ==============================================================================

export const SkillSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  namespace: NamespaceSchema,
  name: SkillNameSchema.nullable(),
  version: z.number().int().positive(),
  description: z.string(),
  descriptionManual: z.boolean(),
  disabled: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  archive: z.instanceof(Uint8Array).nullable(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
});

export type Skill = z.infer<typeof SkillSchema>;

// ==============================================================================
// SKILL SUMMARY (for listing)
// ==============================================================================

export const SkillSortSchema = z.enum(["name", "createdAt"]).default("name");
export type SkillSort = z.infer<typeof SkillSortSchema>;

export const SkillSummarySchema = z.object({
  id: z.string(),
  skillId: z.string(),
  namespace: NamespaceSchema,
  name: SkillNameSchema.nullable(),
  description: z.string(),
  disabled: z.boolean(),
  latestVersion: z.number().int().positive(),
  createdAt: z.coerce.date(),
});

/** Lightweight summary for listing */
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

// ==============================================================================
// VERSION INFO
// ==============================================================================

export const VersionInfoSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.coerce.date(),
  createdBy: z.string(),
});

export type VersionInfo = z.infer<typeof VersionInfoSchema>;

// ==============================================================================
// DB ROW (snake_case for database layer)
// ==============================================================================

/** Schema for parsing database rows with snake_case columns */
export const SkillDbRowSchema = z.object({
  id: z.string(),
  skill_id: z.string(),
  namespace: NamespaceSchema,
  name: SkillNameSchema.nullable(),
  version: z.number().int().positive(),
  description: z.string(),
  description_manual: z.number(),
  disabled: z.number(),
  frontmatter: z.string(), // JSON string in DB
  instructions: z.string(),
  archive: z.instanceof(Uint8Array).nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
