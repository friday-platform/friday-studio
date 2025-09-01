/** MCP server categories for classification */
export type MCPCategory =
  | "development"
  | "cloud"
  | "analytics"
  | "automation"
  | "communication"
  | "testing"
  | "security"
  | "content"
  | "finance"
  | "utility"
  | "database"
  | "project-management"
  | "monitoring";

/** Sources where MCP servers can be discovered */
export type MCPSource = "agents" | "static" | "web";

/** Sources where built-in agents can be discovered */
export type AgentSource = "bundled" | "system" | "sdk" | "yaml";

/** Security rating for MCP servers */
export type SecurityRating = "high" | "medium" | "low" | "unverified";

/** Transport types supported by MCP servers */
export type TransportType = "stdio" | "sse";

/** Authentication types for MCP servers */
export type AuthType = "bearer" | "api_key" | "oauth" | "service_principal" | "none";

/** Tool metadata for MCP servers */
export interface ToolMetadata {
  name: string;
  description: string;
  capabilities: string[];
}

/** MCP server configuration template */
export interface MCPServerConfig {
  transport: { type: TransportType; command?: string; args?: string[]; url?: string };
  auth?: { type: AuthType; token_env?: string };
  tools: { allow?: string[]; deny?: string[] };
  env?: Record<string, string>;
  client_config?: { timeout?: string };
}

/** Comprehensive MCP server metadata */
export interface MCPServerMetadata {
  id: string;
  name: string;
  description: string;
  category: MCPCategory;
  source: MCPSource;
  transportTypes: TransportType[];
  tools: ToolMetadata[];
  useCases: string[];
  securityRating: SecurityRating;
  configTemplate: MCPServerConfig;
  documentation?: string;
  repository?: string;
  package?: string;
  confidence?: number;
}

/** Request for discovering MCP servers */
export interface MCPDiscoveryRequest {
  intent: string;
  domain?: MCPCategory;
  capabilities?: string[];
}

/** Result of MCP discovery with reasoning */
export interface MCPDiscoveryResult {
  server: MCPServerMetadata;
  confidence: number;
  reasoning: string;
  source: MCPSource;
  type?: "mcp"; // Optional for backward compatibility
}

/** Validation result for MCP server configurations */
export interface ValidationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

/** Agent-based discovery configuration */
export interface AgentMCPConfig {
  agentId: string;
  mcpServers: string[];
  usagePattern: string;
  successRate?: number;
}

/** Built-in agent discovery result */
export interface AgentDiscoveryResult {
  agent: {
    id: string;
    name: string;
    description: string;
    expertise: { domains: string[]; capabilities: string[]; examples?: string[] };
    source: AgentSource;
  };
  confidence: number;
  reasoning: string;
  source: AgentSource;
  type: "agent";
}

/** Unified discovery result that can be either an agent or MCP server */
export type UnifiedDiscoveryResult = (MCPDiscoveryResult & { type: "mcp" }) | AgentDiscoveryResult;
