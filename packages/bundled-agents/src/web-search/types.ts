import type { Parallel } from "parallel-web";
import { z } from "zod";

export type SearchResult = Parallel.Beta.SearchResult;

export const QueryAnalysisSchema = z.object({
  complexity: z
    .enum(["simple", "complex"])
    .describe(
      'Query complexity: "simple" for direct lookups (who is X, what is Y, define Z), "complex" for multi-faceted research, comparisons, analysis, or trends',
    ),
  searchQueries: z
    .array(z.string().max(200))
    .min(2)
    .max(6)
    .describe(
      "2-6 strategic keyword queries targeting different facets of the research. Include specific terms, product names, or key concepts. For comparisons, create separate queries for each item. Use synonyms to cast a wider net.",
    ),
  includeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to include - only if user explicitly mentions sites"),
  excludeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to exclude - only if user explicitly mentions sites"),
});

export type QueryAnalysis = z.infer<typeof QueryAnalysisSchema>;
