/**
 * Signal Providers
 * Built-in signal providers for HTTP, webhooks, file watching, and streams
 */

export { type FileWatchSignalConfig, FileWatchSignalProvider } from "./fs-watch-signal.ts";
export { type HTTPSignalConfig, type HTTPSignalData, HTTPSignalProvider } from "./http-signal.ts";

// Export types (except enums which need to be value exports)
export type {
  HealthStatus,
  IAgentProvider,
  IProvider,
  IProviderRegistry,
  IProviderSignal,
  ISignalProvider,
  ProviderConfig,
  ProviderCredentials,
  ProviderState,
} from "./types.ts";

// Export enums as values
export { ProviderStatus, ProviderType } from "./types.ts";
