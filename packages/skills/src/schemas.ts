import { NamespaceSchema, noXmlTags, noXmlTagsMessage, SkillNameSchema } from "@atlas/config";
import { z } from "zod";

export { SkillNameSchema };

// ==============================================================================
// PUBLISH INPUT
// ==============================================================================

/** Input for publishing a new version of a skill (namespace/name come from method params) */
export const PublishSkillInputSchema = z.object({
  description: z.string().min(1).max(1024).refine(noXmlTags, { message: noXmlTagsMessage }),
  instructions: z.string().min(1),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  archive: z.instanceof(Uint8Array).optional(),
});

export type PublishSkillInput = z.infer<typeof PublishSkillInputSchema>;

// ==============================================================================
// STORED SKILL ENTITY
// ==============================================================================

export const SkillSchema = z.object({
  id: z.string(),
  namespace: NamespaceSchema,
  name: SkillNameSchema,
  version: z.number().int().positive(),
  description: z.string(),
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

export const SkillSummarySchema = z.object({
  namespace: NamespaceSchema,
  name: SkillNameSchema,
  description: z.string(),
  latestVersion: z.number().int().positive(),
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
  namespace: NamespaceSchema,
  name: SkillNameSchema,
  version: z.number().int().positive(),
  description: z.string(),
  frontmatter: z.string(), // JSON string in DB
  instructions: z.string(),
  archive: z.instanceof(Uint8Array).nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
