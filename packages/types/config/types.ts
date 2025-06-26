/**
 * Configuration types for Atlas
 * This module contains all TypeScript types inferred from Zod schemas
 */

import { z } from "zod/v4";
import {
  AtlasConfigSchema,
  EnvironmentVariableSchema,
  FederationConfigSchema,
  FederationSharingSchema,
  JobSpecificationSchema,
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
  ServerConfigSchema,
  SupervisorConfigSchema,
  SupervisorDefaultsSchema,
  SupervisorsConfigSchema,
  ToolsConfigSchema,
  TriggerSpecificationSchema,
  WorkspaceAgentConfigSchema,
  WorkspaceConfigSchema,
  WorkspaceIdentitySchema,
  WorkspaceMCPServerConfigSchema,
  WorkspaceSignalConfigSchema,
} from "./schemas.ts";

// Inferred types from Zod schemas
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;
export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;
export type WorkspaceMCPServerConfig = z.infer<typeof WorkspaceMCPServerConfigSchema>;
export type TriggerSpecification = z.infer<typeof TriggerSpecificationSchema>;
export type JobSpecification = z.infer<typeof JobSpecificationSchema>;

// MCP types
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;
export type MCPToolsConfig = z.infer<typeof MCPToolsConfigSchema>;

// New architectural foundation types
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;
export type FederationConfig = z.infer<typeof FederationConfigSchema>;
export type FederationSharing = z.infer<typeof FederationSharingSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;
export type SupervisorsConfig = z.infer<typeof SupervisorsConfigSchema>;
export type SupervisorDefaults = z.infer<typeof SupervisorDefaultsSchema>;

// Merged configuration that combines both
export interface MergedConfig {
  atlas: AtlasConfig;
  workspace: WorkspaceConfig;
  jobs: Record<string, JobSpecification>;
  supervisorDefaults: SupervisorDefaults;
}

// Helper method to extract AgentSupervisor config from AtlasConfig
export function getAgentSupervisorConfig(atlasConfig: AtlasConfig): {
  model: string;
  prompts: Record<string, string>;
} {
  return {
    model: atlasConfig.supervisors.agent.model,
    prompts: atlasConfig.supervisors.agent.prompts,
  };
}
