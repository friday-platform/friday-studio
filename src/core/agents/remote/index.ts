/**
 * Remote Agent module exports
 * Provides unified access to remote agent functionality
 */

// Main remote agent implementation
export { RemoteAgent, type RemoteAgentMetadata } from "./remote-agent.ts";

// Adapter factory and interfaces
export { RemoteAdapterFactory, type RemoteProtocol } from "./adapter-factory.ts";
export { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./adapters/base-remote-adapter.ts";

// Protocol-specific adapters
export { ACPAdapter, type ACPAdapterConfig } from "./adapters/acp-adapter.ts";
export { A2AAdapter, type A2AAdapterConfig } from "./adapters/a2a-adapter.ts";
export { CustomAdapter, type CustomAdapterConfig } from "./adapters/custom-adapter.ts";

// Types and interfaces
export type {
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteExecutionEvent,
  RemoteMessagePart,
  RemoteExecutionMode,
  RemoteExecutionStatus,
  RemoteEventType,
  RemoteExecutionMetadata,
  HealthStatus,
  RemoteAgentInfo,
  RemoteConnectionConfig,
  RemoteAuthConfig,
  CircuitBreakerState,
  RetryConfig,
  RemoteAgentMetrics,
} from "./types.ts";

// Error classes
export {
  RemoteAgentError,
  RemoteConnectionError,
  RemoteTimeoutError,
  RemoteAuthenticationError,
  RemoteValidationError,
  CircuitBreakerOpenError,
} from "./types.ts";