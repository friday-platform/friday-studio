// Agent loading system

export { BundledAgentAdapter } from "./adapters/bundled-adapter.ts";
export { SDKAgentAdapter } from "./adapters/sdk-adapter.ts";

// Adapters for different agent sources
export { SystemAgentAdapter } from "./adapters/system-adapter.ts";
// Types and utilities
export type {
  AgentAdapter,
  AgentSourceData,
  AgentSourceType,
  AgentSummary,
} from "./adapters/types.ts";
export { isSystemAgent } from "./adapters/types.ts";
export { YAMLFileAdapter } from "./adapters/yaml-file-adapter.ts";
export { AgentLoader, type LoaderOptions } from "./loader.ts";
export { AgentRegistry } from "./registry.ts";
