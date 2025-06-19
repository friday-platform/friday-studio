/**
 * Extended Model Context Protocol (EMCP) Implementation
 *
 * Atlas extension of MCP with enterprise orchestration capabilities
 */

export type {
  APIContextSpec,
  CodebaseContextSpec,
  ContextSpec,
  DatabaseContextSpec,
  EMCPCapability,
  EMCPConstraints,
  EMCPContext,
  EMCPCostInfo,
  EMCPCostMetrics,
  EMCPProviderConfig,
  EMCPResource,
  EMCPResourceContent,
  EMCPResult,
  EMCPSecurityRequirements,
  IEMCPProvider,
} from "./emcp-provider.ts";

export { EMCPRegistry } from "./emcp-registry.ts";
export type { ProviderDiscoveryResult, ProviderRegistration } from "./emcp-registry.ts";

export { BaseEMCPProvider } from "./providers/base-provider.ts";
export { FilesystemProvider } from "./providers/filesystem-provider.ts";
export type { FilesystemProviderConfig } from "./providers/filesystem-provider.ts";
