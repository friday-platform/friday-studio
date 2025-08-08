// Agent loading system
export { AgentLoader, type LoaderOptions } from "./loader.ts";
export { AgentRegistry } from "./registry.ts";

// Adapters for different agent sources
export { SystemAgentAdapter } from "./adapters/system-adapter.ts";
export { BundledAgentAdapter } from "./adapters/bundled-adapter.ts";
export { YAMLFileAdapter } from "./adapters/yaml-file-adapter.ts";
export { SDKAgentAdapter } from "./adapters/sdk-adapter.ts";

// Types and utilities
export type {
  AgentAdapter,
  AgentSourceData,
  AgentSourceType,
  AgentSummary,
} from "./adapters/types.ts";
export { isSystemAgent } from "./adapters/types.ts";
