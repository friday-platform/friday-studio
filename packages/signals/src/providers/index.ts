/**
 * Signal Providers
 * Built-in signal providers for HTTP, webhooks, timers, streams, and Kubernetes events
 */

export { type FileWatchSignalConfig, FileWatchSignalProvider } from "./fs-watch-signal.ts";
export { type HTTPSignalConfig, type HTTPSignalData, HTTPSignalProvider } from "./http-signal.ts";
export {
  type TimerSignalConfig,
  type TimerSignalData,
  TimerSignalProvider,
} from "./timer-signal.ts";

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
