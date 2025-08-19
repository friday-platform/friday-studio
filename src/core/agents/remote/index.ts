/**
 * Remote Agent module exports
 * Provides unified access to remote agent functionality
 */

// Adapter factory and interfaces
export { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./adapters/base-remote-adapter.ts";

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
