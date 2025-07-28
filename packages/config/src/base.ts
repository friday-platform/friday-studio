/**
 * Base types and enums for Atlas configuration v2
 */

import { z } from "zod/v4";

// ==============================================================================
// ENUMS AND CONSTANTS
// ==============================================================================

export const AgentType = z.enum(["llm", "system", "remote"]);
export type AgentType = z.infer<typeof AgentType>;

export const ExecutionStrategy = z.enum(["sequential", "parallel"]);
export type ExecutionStrategy = z.infer<typeof ExecutionStrategy>;

export const SupervisionLevel = z.enum(["minimal", "standard", "detailed"]);
export type SupervisionLevel = z.infer<typeof SupervisionLevel>;

export const SignalProvider = z.enum(["http", "schedule", "system"]);
export type SignalProvider = z.infer<typeof SignalProvider>;

export const MemoryScope = z.enum(["workspace", "session", "agent"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

// ==============================================================================
// UTILITY SCHEMAS
// ==============================================================================

/**
 * Duration format validation (e.g., "30s", "5m", "2h")
 */
export const DurationSchema = z.string().regex(/^\d+[smh]$/, {
  message: "Duration must be in format: number + s/m/h (e.g., '30s', '5m', '2h')",
});
export type Duration = z.infer<typeof DurationSchema>;

/**
 * Parse duration string to milliseconds
 * @param duration - Duration string in format like "30s", "5m", "2h"
 * @returns Duration in milliseconds
 */
export function parseDuration(duration: Duration): number {
  const match = duration.match(/^(\d+)([smh])$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * MCP-compliant tool name (letters, numbers, underscore, hyphen)
 */
export const MCPToolNameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, {
  message: "Must contain only letters, numbers, underscores, and hyphens",
});
export type MCPToolName = z.infer<typeof MCPToolNameSchema>;

/**
 * JSON Schema object representation
 */
export const SchemaObjectSchema = z.record(z.string(), z.unknown());
export type SchemaObject = z.infer<typeof SchemaObjectSchema>;

/**
 * Condition schema supporting both JSONLogic and natural language prompts
 */
export const ConditionSchema = z.union([
  z.strictObject({
    jsonlogic: z.unknown().describe("JSONLogic expression (cached and executed at runtime)"),
  }),
  z.strictObject({
    prompt: z.string().describe("Natural language prompt (converted to JSONLogic and cached)"),
  }),
]).describe("Condition that can be either JSONLogic or a natural language prompt");
export type Condition = z.infer<typeof ConditionSchema>;

/**
 * Allow/Deny filter with mutual exclusion validation
 */
export const AllowDenyFilterSchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}).refine(
  (data) => !(data.allow && data.deny),
  { message: "Cannot specify both allow and deny lists" },
);
export type AllowDenyFilter = z.infer<typeof AllowDenyFilterSchema>;

/**
 * Success configuration with condition and optional schema
 */
export const SuccessConfigSchema = z.strictObject({
  condition: ConditionSchema,
  schema: SchemaObjectSchema.optional().describe("Structured output schema"),
});
export type SuccessConfig = z.infer<typeof SuccessConfigSchema>;

/**
 * Error configuration with condition
 */
export const ErrorConfigSchema = z.strictObject({
  condition: ConditionSchema,
});
export type ErrorConfig = z.infer<typeof ErrorConfigSchema>;

// ==============================================================================
// WORKSPACE IDENTITY
// ==============================================================================

export const WorkspaceIdentitySchema = z.strictObject({
  // ID is required for atlas platform workspace
  id: z.string().optional().describe("Workspace ID (required for platform workspace)"),
  name: z.string().min(1, "Workspace name cannot be empty"),
  version: z.string().optional().describe("Workspace version"),
  description: z.string().optional().describe("Workspace description"),
});
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

// ==============================================================================
// FEDERATION
// ==============================================================================

export const ScopeSchema = z.union([
  z.string(),
  z.array(z.string()),
]).describe("Single scope or array of scopes");
export type Scope = z.infer<typeof ScopeSchema>;

export const FederationGrantSchema = z.strictObject({
  workspace: z.string(),
  scopes: ScopeSchema,
});
export type FederationGrant = z.infer<typeof FederationGrantSchema>;

export const FederationSharingEntrySchema = z.strictObject({
  workspaces: z.union([z.string(), z.array(z.string())]).optional(),
  scopes: ScopeSchema.optional(),
  grants: z.array(FederationGrantSchema).optional(),
});
export type FederationSharingEntry = z.infer<typeof FederationSharingEntrySchema>;

export const FederationConfigSchema = z.strictObject({
  sharing: z.record(z.string(), FederationSharingEntrySchema).optional(),
  scope_sets: z.record(z.string(), z.array(z.string())).optional(),
});
export type FederationConfig = z.infer<typeof FederationConfigSchema>;
