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
 * Where a doctor-surfaced env var came from. `friday` (the doctor extracted it
 * from the README) carries the excerpt it was read from; `registry` (declared
 * upstream) and `user` (typed into the manual-config form) need no evidence.
 */
export const DoctorEnvVarProvenanceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("registry") }),
  z.object({ source: z.literal("friday"), readme_excerpt: z.string() }),
  z.object({ source: z.literal("user") }),
]);
export type DoctorEnvVarProvenance = z.infer<typeof DoctorEnvVarProvenanceSchema>;

/** A single env var the doctor surfaced, tagged with where it came from. */
export const DoctorEnvVarSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean(),
  isSecret: z.boolean(),
  default: z.string().optional(),
  provenance: DoctorEnvVarProvenanceSchema,
});
export type DoctorEnvVar = z.infer<typeof DoctorEnvVarSchema>;

/** A qualitative observation from the doctor — what it saw and how serious it is. */
export const DoctorFindingSchema = z.object({
  severity: z.enum(["info", "warn", "error"]),
  title: z.string().min(1),
  detail: z.string(),
});
export type DoctorFinding = z.infer<typeof DoctorFindingSchema>;

/**
 * The doctor's output — a tagged union on `verdict` so impossible states are
 * unrepresentable. `clean` carries no env var list at all; `attention` requires
 * a non-empty one; `unknown` requires at least one finding explaining itself.
 *
 * Verdicts are state-coded: each names the *shape of the user's next action*
 * (nothing / review-and-apply / investigate-manually), not the finding content.
 */
export const DoctorReportSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("clean"),
    tldr: z.string(),
    findings: z.array(DoctorFindingSchema),
  }),
  z.object({
    verdict: z.literal("attention"),
    tldr: z.string(),
    findings: z.array(DoctorFindingSchema),
    env_vars: z.array(DoctorEnvVarSchema).min(1),
  }),
  z.object({
    verdict: z.literal("unknown"),
    tldr: z.string(),
    findings: z.array(DoctorFindingSchema).min(1),
  }),
]);
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

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

  /**
   * Install lifecycle state. Absent on entries created before the doctor flow
   * landed and on static blessed servers — treat absent as `ready`.
   */
  status: z.enum(["setting_up", "awaiting_confirm", "ready"]).optional(),
  /** The setup doctor's output. Present whenever the doctor ran at install. */
  doctor_report: DoctorReportSchema.optional(),

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
