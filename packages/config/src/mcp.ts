/**
 * MCP (Model Context Protocol) schemas
 *
 * Atlas uses "MCP" for two different purposes:
 * 1. Protocol MCP - External tool integration (agents calling out)
 * 2. Platform MCP - Atlas exposing its capabilities (external systems calling in)
 */

import { z } from "zod/v4";
import { AllowDenyFilterSchema, DurationSchema, WorkspaceTimeoutConfigSchema } from "./base.ts";

// ==============================================================================
// PROTOCOL MCP - External tool integration (agents calling MCP servers)
// ==============================================================================

/**
 * MCP transport configuration
 */
const MCPTransportStdioSchema = z.strictObject({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
});

const MCPTransportHTTPSchema = z.strictObject({
  type: z.literal("http"),
  url: z.url(),
});

const MCPTransportSSESchema = z.strictObject({
  type: z.literal("sse"),
  url: z.url(),
});

export const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  MCPTransportStdioSchema,
  MCPTransportHTTPSchema,
  MCPTransportSSESchema,
]);
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;

/**
 * MCP authentication configuration
 */
export const MCPAuthConfigSchema = z.strictObject({
  type: z.enum(["bearer", "api_key", "basic"]),
  header: z.string().optional().describe("Header name for the token"),
  token_env: z.string().optional().describe("Environment variable containing the token"),
  username_env: z.string().optional().describe("For basic auth"),
  password_env: z.string().optional().describe("For basic auth"),
});
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;

/**
 * Tool filter for MCP servers - which tools to allow/deny
 */
export const MCPServerToolFilterSchema = AllowDenyFilterSchema.describe(
  "Filter which tools to allow or deny from this MCP server",
);
export type MCPServerToolFilter = z.infer<typeof MCPServerToolFilterSchema>;

/**
 * Individual MCP server configuration
 */
export const MCPServerConfigSchema = z.strictObject({
  transport: MCPTransportConfigSchema,
  client_config: z.strictObject({
    timeout: WorkspaceTimeoutConfigSchema.optional(),
  }).optional(),
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPServerToolFilterSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe(
    "Environment variables for the server process",
  ),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/**
 * MCP client configuration for calling external MCP servers
 */
export const MCPClientConfigSchema = z.strictObject({
  client_config: z.strictObject({
    timeout: WorkspaceTimeoutConfigSchema.default({
      progressTimeout: "2m",
      maxTotalTimeout: "30m",
    }).describe("Watchdog timeout configuration"),
  }).default({
    timeout: {
      progressTimeout: "2m",
      maxTotalTimeout: "30m",
    },
  }),
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
  discoverable: z.strictObject({
    capabilities: z.array(z.string()).optional().describe(
      "Capability patterns to expose (e.g., 'workspace_*')",
    ),
    jobs: z.array(z.string()).optional().describe("Job patterns to expose as MCP tools"),
  }).optional(),
});
export type PlatformMCPConfig = z.infer<typeof PlatformMCPConfigSchema>;

/**
 * Extended platform MCP configuration (atlas.yml only)
 */
export const AtlasPlatformMCPConfigSchema = PlatformMCPConfigSchema.extend({
  transport: MCPTransportConfigSchema.optional(),
  auth: z.strictObject({
    required: z.boolean().default(false),
    providers: z.array(z.string()).optional(),
  }).optional(),
  rate_limits: z.strictObject({
    requests_per_hour: z.number().int().positive().optional(),
    concurrent_sessions: z.number().int().positive().optional(),
  }).optional(),
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
    tool_policy: z.strictObject({
      type: z.enum(["allowlist", "denylist"]).default("allowlist"),
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    }).optional().describe("Platform-level MCP tool security policies"),
  }).optional(),
});
export type AtlasToolsConfig = z.infer<typeof AtlasToolsConfigSchema>;
