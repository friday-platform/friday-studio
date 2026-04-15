import { z } from "zod";

export const AuthorSkillInputSchema = z.strictObject({
  request: z.string().min(1).describe("Natural-language description of the skill to create"),
  targetNamespace: z
    .string()
    .optional()
    .default("@tempest")
    .describe("Skill namespace — defaults to @tempest"),
});

export type AuthorSkillInput = z.infer<typeof AuthorSkillInputSchema>;

export const SkillPlanResultSchema = z.strictObject({
  name: z.string().describe("snake-case skill name"),
  description: z
    .string()
    .max(1024)
    .describe("Skill description — must be under 1024 chars per SkillFrontmatterSchema"),
  instructions_outline: z.string().describe("Markdown outline of the skill instructions"),
  reference_files_needed: z
    .array(z.string())
    .describe("List of reference file names the skill will include"),
});

export type SkillPlanResult = z.infer<typeof SkillPlanResultSchema>;

export const SkillScaffoldResultSchema = z.strictObject({
  name: z.string(),
  instructions_md: z
    .string()
    .describe("Full SKILL.md content with frontmatter + instructions body"),
  reference_files: z
    .record(z.string(), z.string())
    .describe("Map of filename → file content for reference files"),
});

export type SkillScaffoldResult = z.infer<typeof SkillScaffoldResultSchema>;

export const SkillReviewResultSchema = z.strictObject({
  verdict: z
    .enum(["APPROVE", "BLOCK"])
    .describe("APPROVE proceeds to publish; BLOCK halts the FSM"),
  findings: z.array(
    z.strictObject({
      severity: z.enum(["CRITICAL", "WARNING", "SUGGESTION"]),
      description: z.string(),
      plan_line: z.string().describe("Source citation for traceability"),
    }),
  ),
});

export type SkillReviewResult = z.infer<typeof SkillReviewResultSchema>;

export const SkillPublishResultSchema = z.strictObject({
  published: z.boolean(),
  version: z.number().int().describe("Version number returned by the publish API"),
  namespace: z.string(),
  name: z.string(),
});

export type SkillPublishResult = z.infer<typeof SkillPublishResultSchema>;
