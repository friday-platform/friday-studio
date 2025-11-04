import type { MCPServerConfig } from "@atlas/config";
import { z } from "zod";

/**
 * MCP server categories for classification
 */
const MCPCategorySchema = z.enum([
  "development",
  "cloud",
  "analytics",
  "automation",
  "communication",
  "testing",
  "security",
  "content",
  "finance",
  "utility",
  "database",
  "project-management",
  "monitoring",
]);

export type MCPCategory = z.infer<typeof MCPCategorySchema>;

/**
 * Security rating for MCP servers
 */
const SecurityRatingSchema = z.enum(["high", "medium", "low", "unverified"]);
export type SecurityRating = z.infer<typeof SecurityRatingSchema>;

/**
 * Required configuration field descriptor
 * Describes what users must provide for this server to work
 */
const RequiredConfigFieldSchema = z.object({
  key: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["string", "array", "object", "number"]),
  examples: z.array(z.string()).optional(),
});

export type RequiredConfigField = z.infer<typeof RequiredConfigFieldSchema>;

/**
 * MCP Source - where the server was discovered
 */
export type MCPSource = "agents" | "static" | "web";

/**
 * Enhanced MCP server metadata with domains and required config
 * Uses the official MCPServerConfig from @atlas/config for configTemplate
 */
export type MCPServerMetadata = {
  // Identity
  id: string;
  name: string;

  // Classification (enhanced with domains for semantic matching)
  category: MCPCategory;
  domains: string[];

  // Security & Quality
  securityRating: SecurityRating;
  source: MCPSource;

  // Configuration - uses official type from @atlas/config
  configTemplate: MCPServerConfig;
  requiredConfig?: RequiredConfigField[];
};

/**
 * Registry metadata
 */
const RegistryMetadataSchema = z.object({ version: z.string(), lastUpdated: z.string() });

export type RegistryMetadata = z.infer<typeof RegistryMetadataSchema>;

/**
 * Consolidated MCP servers registry
 * Changed from array to Record for O(1) lookup
 */
export type MCPServersRegistry = {
  servers: Record<string, MCPServerMetadata>;
  categories: MCPCategory[];
  metadata: RegistryMetadata;
};
