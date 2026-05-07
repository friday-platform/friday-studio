/**
 * MCP (Model Context Protocol) schemas
 *
 * Atlas uses "MCP" for two different purposes:
 * 1. Protocol MCP - External tool integration (agents calling out)
 * 2. Platform MCP - Atlas exposing its capabilities (external systems calling in)
 */

import {
  type MCPAuthConfig,
  MCPAuthConfigSchema,
  type MCPServerConfig,
  MCPServerConfigSchema,
  type MCPServerToolFilter,
  MCPServerToolFilterSchema,
  type MCPStartupConfig,
  MCPStartupConfigSchema,
  type MCPTransportConfig,
  MCPTransportConfigSchema,
} from "@atlas/agent-sdk";
import { z } from "zod";
import { WorkspaceTimeoutConfigSchema } from "./base.ts";

// ==============================================================================
// PROTOCOL MCP - External tool integration (agents calling MCP servers)
// ==============================================================================

// Note: Core MCP types (MCPTransportConfig, MCPAuthConfig, MCPServerToolFilter)
// are imported from @atlas/agent-sdk above

/**
 * K6 (melodic-strolling-seal-pt3) — workspace-level MCP server config that
 * extends the agent-sdk's `MCPServerConfig` with an optional per-server
 * `validation:` override. The `validate-classifier` honors this over its
 * regex / allowlist defaults: `"read-only"` makes ALL tools from that
 * server skip-eligible regardless of name; `"mutating"` makes them
 * never skip-eligible. Default (omitted) falls back to the per-tool
 * regex match in `READ_ONLY_ALLOWLIST` / `MUTATING_VERB_RE`.
 *
 * Structurally a superset of `MCPServerConfig` — values without the new
 * field are assignable in either direction since `validation` is
 * optional.
 */
export const WorkspaceMCPServerConfigSchema = MCPServerConfigSchema.extend({
  validation: z
    .enum(["read-only", "mutating"])
    .optional()
    .describe(
      "Author override for the validate-classifier. read-only makes every tool from this server skip-eligible; mutating forces self-validation regardless of name. Omit to fall back to the per-tool regex defaults.",
    ),
});
export type WorkspaceMCPServerConfig = z.infer<typeof WorkspaceMCPServerConfigSchema>;

/**
 * MCP client configuration for calling external MCP servers
 */
export const MCPClientConfigSchema = z.strictObject({
  client_config: z
    .strictObject({
      timeout: WorkspaceTimeoutConfigSchema.default({
        progressTimeout: "2m",
        maxTotalTimeout: "30m",
      }).describe("Watchdog timeout configuration"),
    })
    .default({ timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } }),
  servers: z.record(z.string(), WorkspaceMCPServerConfigSchema).optional(),
});
export type MCPClientConfig = z.infer<typeof MCPClientConfigSchema>;

// ==============================================================================
// PLATFORM MCP - Atlas exposing its capabilities
// ==============================================================================

/**
 * Basic platform MCP configuration (workspace.yml)
 */
export const PlatformMCPConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  discoverable: z
    .strictObject({
      capabilities: z
        .array(z.string())
        .optional()
        .describe("Capability patterns to expose (e.g., 'workspace_*')"),
      jobs: z.array(z.string()).optional().describe("Job patterns to expose as MCP tools"),
    })
    .optional(),
});
export type PlatformMCPConfig = z.infer<typeof PlatformMCPConfigSchema>;

/**
 * Extended platform MCP configuration (friday.yml only)
 */
export const AtlasPlatformMCPConfigSchema = PlatformMCPConfigSchema.extend({
  transport: MCPTransportConfigSchema.optional(),
  auth: z
    .strictObject({
      required: z.boolean().default(false),
      providers: z.array(z.string()).optional(),
    })
    .optional(),
  rate_limits: z
    .strictObject({
      requests_per_hour: z.number().int().positive().optional(),
      concurrent_sessions: z.number().int().positive().optional(),
    })
    .optional(),
});
export type AtlasPlatformMCPConfig = z.infer<typeof AtlasPlatformMCPConfigSchema>;

// ==============================================================================
// TOOLS CONFIGURATION
// ==============================================================================

/**
 * Tools configuration - agents calling external MCP servers
 */
export const ToolsConfigSchema = z.strictObject({
  mcp: MCPClientConfigSchema.optional().describe("MCP servers that agents can call"),
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

/**
 * Extended tools configuration with policies (friday.yml only)
 */
export const AtlasToolsConfigSchema = ToolsConfigSchema.extend({
  mcp: MCPClientConfigSchema.extend({
    tool_policy: z
      .strictObject({
        type: z.enum(["allowlist", "denylist"]).default("allowlist"),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .optional()
      .describe("Platform-level MCP tool security policies"),
  }).optional(),
});
export type AtlasToolsConfig = z.infer<typeof AtlasToolsConfigSchema>;

// Re-export MCP types from agent-sdk for backward compatibility
export {
  type MCPAuthConfig,
  MCPAuthConfigSchema,
  type MCPServerConfig,
  MCPServerConfigSchema,
  type MCPServerToolFilter,
  MCPServerToolFilterSchema,
  type MCPStartupConfig,
  MCPStartupConfigSchema,
  type MCPTransportConfig,
  MCPTransportConfigSchema,
};

/** K6 — short alias for the per-server validation override. */
export type WorkspaceMCPServerValidation = "read-only" | "mutating";
