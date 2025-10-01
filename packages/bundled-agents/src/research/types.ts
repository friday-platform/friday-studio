import { z } from "zod";

/**
 * Research depth levels:
 * - quick: 1-2 searches for meeting prep, basic facts
 * - standard: 2-4 searches for comprehensive overview
 * - deep: 4-5 searches for detailed analysis
 */
export const researchDepth = z
  .enum(["quick", "standard", "deep"])
  .meta({ description: "Research depth for this query" });

export type ResearchDepth = z.infer<typeof researchDepth>;
