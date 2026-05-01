import { EnvValueSchema, MCPServerConfigSchema } from "@atlas/agent-sdk";
import { z } from "zod";

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
export const MCPSourceSchema = z.enum(["agents", "static", "web", "registry", "workspace"]);
export type MCPSource = z.infer<typeof MCPSourceSchema>;

/**
 * Upstream provenance for registry-imported entries
 * Tracks origin for update checking and audit trails
 */
export const MCPUpstreamProvenanceSchema = z.object({
  canonicalName: z.string(),
  version: z.string(),
  updatedAt: z.string(),
});
export type MCPUpstreamProvenance = z.infer<typeof MCPUpstreamProvenanceSchema>;

/**
 * Enhanced MCP server metadata with required config
 * Uses the official MCPServerConfigSchema from @atlas/agent-sdk for configTemplate
 */
export const MCPServerMetadataSchema = z.object({
  // Identity
  id: z.string(),
  name: z.string(),
  /** URL domains for URL-to-MCP mapping (e.g., "linear.app", "github.com") */
  urlDomains: z.array(z.string()).optional(),

  // Description & Constraints (for LLM prompt injection)
  /** What this server does - shown to LLMs for capability selection */
  description: z.string().optional(),
  /** Limitations or usage guidance - helps LLMs choose between similar capabilities */
  constraints: z.string().optional(),

  // Security & Quality
  securityRating: SecurityRatingSchema,
  source: MCPSourceSchema,

  // Upstream provenance (only for registry-imported entries)
  upstream: MCPUpstreamProvenanceSchema.optional(),

  // Configuration - uses official schema from @atlas/agent-sdk
  configTemplate: MCPServerConfigSchema,
  /**
   * Registry-owned environment variables that are merged into the runtime
   * startup environment but are NOT serialized into workspace.yml.
   * Used for platform-wide credentials and flags (e.g., Google OAuth client ID)
   * that should not leak into per-workspace configuration.
   */
  platformEnv: z.record(z.string(), EnvValueSchema).optional(),
  requiredConfig: z.array(RequiredConfigFieldSchema).optional(),

  // README content fetched from the upstream repository (stored at install time)
  readme: z.string().optional(),
});

export type MCPServerMetadata = z.infer<typeof MCPServerMetadataSchema>;

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
  metadata: RegistryMetadata;
};
