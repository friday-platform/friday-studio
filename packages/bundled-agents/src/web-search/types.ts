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
    .max(10)
    .describe(
      "2-10 strategic keyword queries targeting different facets of the research. Include specific terms, product names, or key concepts. For many items, combine related ones into fewer queries.",
    ),
  includeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to include - only if user explicitly mentions sites"),
  excludeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to exclude - only if user explicitly mentions sites"),
  recencyDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Filter results to this many days back. Use for news/monitoring (7), recent trends (30-90), or annual reviews (365). Omit for timeless or historical queries.",
    ),
});

export type QueryAnalysis = z.infer<typeof QueryAnalysisSchema>;
