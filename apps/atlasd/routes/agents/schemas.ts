import { z } from "zod";

export const agentIdParamsSchema = z.object({ id: z.string().min(1).describe("Agent identifier") });

export const agentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  category: z.enum(["system", "bundled", "sdk", "yaml"]),
  expertise: z
    .object({
      domains: z.array(z.string()),
      capabilities: z.array(z.string()),
      examples: z.array(z.string()),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const agentListResponseSchema = z.object({
  agents: z.array(agentMetadataSchema),
  total: z.number(),
});

export const agentExpertiseSchema = z.object({
  agentId: z.string(),
  domains: z.array(z.string()),
  capabilities: z.array(z.string()),
  examples: z.array(z.string()),
  recommendedFor: z.array(z.string()).optional(),
});

export const errorResponseSchema = z.object({ error: z.string() });
