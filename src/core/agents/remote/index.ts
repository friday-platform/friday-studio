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

// Types and interfaces
export type {
  CircuitBreakerState,
  HealthStatus,
  RemoteAgentInfo,
  RemoteAgentMetrics,
  RemoteAuthConfig,
  RemoteConnectionConfig,
  RemoteEventType,
  RemoteExecutionEvent,
  RemoteExecutionMetadata,
  RemoteExecutionMode,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteExecutionStatus,
  RemoteMessagePart,
  RetryConfig,
} from "./types.ts";

// Error classes
export {
  CircuitBreakerOpenError,
  RemoteAgentError,
  RemoteAuthenticationError,
  RemoteConnectionError,
  RemoteTimeoutError,
  RemoteValidationError,
} from "./types.ts";
