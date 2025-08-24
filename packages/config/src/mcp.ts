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
  type MCPTransportConfig,
  MCPTransportConfigSchema,
} from "@atlas/agent-sdk";
import { z } from "zod/v4";
import { WorkspaceTimeoutConfigSchema } from "./base.ts";

// ==============================================================================
// PROTOCOL MCP - External tool integration (agents calling MCP servers)
// ==============================================================================

// Note: Core MCP types (MCPTransportConfig, MCPAuthConfig, MCPServerToolFilter)
// are imported from @atlas/agent-sdk above

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
  servers: z.record(z.string(), MCPServerConfigSchema).optional(),
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
 * Extended platform MCP configuration (atlas.yml only)
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
 * Extended tools configuration with policies (atlas.yml only)
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
  type MCPTransportConfig,
  MCPTransportConfigSchema,
};
