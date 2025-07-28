/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace functionality moved to @atlas/workspace package

// Export all LLM provider types and interfaces
export type { LLMOptions, LLMResponse } from "./src/llm-provider.ts";
export { LLMProvider } from "./src/llm-provider.ts";

// Credential Fetcher
export {
  CredentialFetcher,
  type Credentials,
  type FetchCredentialsOptions,
} from "./src/credential-fetcher.ts";

// Atlas Configuration
export { getAtlasBaseUrl, getCredentialsApiUrl, getDiagnosticsApiUrl } from "./src/atlas-config.ts";

// Actor Types
export * from "./src/types/actors.ts";
export * from "./src/types/agent-execution.ts";
export * from "./src/types/xstate-events.ts";
export * from "./src/types/xstate-contexts.ts";
