/**
 * @atlas/tools - Atlas Tool Registry for AI SDK
 *
 * This package provides all Atlas MCP tools formatted for AI SDK compatibility.
 * Each tool follows the AI SDK pattern and can be used individually or as part
 * of the complete registry.
 *
 * @example
 * ```typescript
 * import { atlasTools, getAtlasToolRegistry } from "@atlas/tools";
 * import { filesystemTools } from "@atlas/tools/filesystem";
 *
 * // Use all tools
 * const registry = getAtlasToolRegistry();
 * const allTools = registry.getAllTools();
 *
 * // Use specific category
 * const fsTools = registry.getToolsByCategory("filesystem");
 *
 * // Use individual tools
 * const readTool = filesystemTools.atlas_read;
 * ```
 */

// Export main registry components
export {
  AtlasToolRegistry,
  atlasTools,
  getAtlasToolRegistry,
  type MCPToolsAdapterConfig,
  type ToolCategory,
} from "./src/registry.ts";

// Export MCP adapter
export { MCPToolsAdapter } from "./src/external-adapters/index.ts";

// Export individual tool categories
export {
  agentTools,
  conversationTools,
  draftTools,
  filesystemTools,
  jobTools,
  libraryTools,
  sessionTools,
  signalTools,
  systemTools,
  workspaceTools,
} from "./src/internal/index.ts";

// Export utilities
export { defaultContext, fetchWithTimeout, handleDaemonResponse } from "./src/utils.ts";

// Export organized tool categories
export * as internal from "./src/internal/index.ts";
export * as externalAdapters from "./src/external-adapters/index.ts";
// Default export for convenience
export { atlasTools as default } from "./src/registry.ts";
