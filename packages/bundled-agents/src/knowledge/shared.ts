import { z } from "zod";

/**
 * Output schema for the knowledge agent.
 */
export const KnowledgeOutputSchema = z.object({
  response: z.string().describe("Answer with inline source citations"),
  sources: z
    .array(
      z.object({
        sectionTitle: z.string(),
        chapter: z.string(),
        lineStart: z.number(),
        lineEnd: z.number(),
        sourceFile: z.string(),
      }),
    )
    .describe("Sections referenced in the response"),
});

export type KnowledgeResult = z.infer<typeof KnowledgeOutputSchema>;

export interface KnowledgeSource {
  sectionTitle: string;
  chapter: string;
  lineStart: number;
  lineEnd: number;
  sourceFile: string;
}
