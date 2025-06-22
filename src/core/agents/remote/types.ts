/**
 * Type definitions for remote agent communication
 * Provides abstraction layer over different remote agent protocols (ACP)
 */

// Base types for remote agent communication
export interface RemoteExecutionRequest {
  agentName: string;
  input: string | RemoteMessagePart[];
  sessionId?: string;
  mode: RemoteExecutionMode;
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface RemoteExecutionResult {
  executionId: string;
  output: RemoteMessagePart[];
  status: RemoteExecutionStatus;
  error?: string;
  metadata: RemoteExecutionMetadata;
}

export interface RemoteExecutionEvent {
  type: RemoteEventType;
  content?: string;
  contentType?: string;
  status?: RemoteExecutionStatus;
  output?: RemoteMessagePart[];
  error?: string;
  metadata?: Record<string, unknown>;
}

// Message parts for flexible content handling
export interface RemoteMessagePart {
  content_type: string;
  content: string | ArrayBuffer | Record<string, unknown>;
  name?: string;
  metadata?: Record<string, unknown>;
}

// Execution modes supported by remote agents
export type RemoteExecutionMode = "sync" | "async" | "stream";

// Execution statuses
export type RemoteExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting";

// Event types for streaming
export type RemoteEventType =
  | "content"
  | "completion"
  | "error"
  | "metadata"
  | "progress"
  | "session_start"
  | "session_end"
  | "awaiting";

// Execution metadata
export interface RemoteExecutionMetadata {
  execution_time_ms: number;
  tokens_used?: number;
  model_used?: string;
  session_id?: string;
  agent_version?: string;
  cost?: {
    input_tokens?: number;
    output_tokens?: number;
    total_cost_usd?: number;
  };
  performance?: {
    queue_time_ms?: number;
    processing_time_ms?: number;
    network_latency_ms?: number;
  };
}

// Health status for monitoring
export interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  latency_ms?: number;
  error?: string;
  version?: string;
  capabilities?: string[];
  last_check?: Date;
  uptime_seconds?: number;
}

// Agent discovery information
export interface RemoteAgentInfo {
  name: string;
  description?: string;
  version?: string;
  capabilities?: string[];
  supported_modes?: RemoteExecutionMode[];
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Connection configuration for adapters
export interface RemoteConnectionConfig {
  endpoint: string;
  timeout?: number;
  retries?: number;
  keepAlive?: boolean;
  headers?: Record<string, string>;
}

// Authentication configuration
export interface RemoteAuthConfig {
  type: "bearer" | "api_key" | "basic" | "none";
  token_env?: string;
  token?: string;
  api_key_env?: string;
  api_key?: string;
  header?: string;
  username?: string;
  password?: string;
}

// Circuit breaker state for reliability
export interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failure_count: number;
  last_failure?: Date;
  next_attempt?: Date;
}

// Retry configuration
export interface RetryConfig {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  backoff_multiplier: number;
  retryable_errors?: string[];
}

// Monitoring metrics
export interface RemoteAgentMetrics {
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  average_latency_ms: number;
  circuit_breaker_state: CircuitBreakerState;
  last_health_check?: Date;
  uptime_percentage?: number;
}

// Error types for remote agent operations
export class RemoteAgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "RemoteAgentError";
  }
}

export class RemoteConnectionError extends RemoteAgentError {
  constructor(message: string, statusCode?: number) {
    super(message, "CONNECTION_ERROR", statusCode, true);
    this.name = "RemoteConnectionError";
  }
}

export class RemoteTimeoutError extends RemoteAgentError {
  constructor(message: string) {
    super(message, "TIMEOUT_ERROR", undefined, true);
    this.name = "RemoteTimeoutError";
  }
}

export class RemoteAuthenticationError extends RemoteAgentError {
  constructor(message: string) {
    super(message, "AUTH_ERROR", 401, false);
    this.name = "RemoteAuthenticationError";
  }
}

export class RemoteValidationError extends RemoteAgentError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400, false);
    this.name = "RemoteValidationError";
  }
}

export class CircuitBreakerOpenError extends RemoteAgentError {
  constructor(message: string) {
    super(message, "CIRCUIT_BREAKER_OPEN", 503, true);
    this.name = "CircuitBreakerOpenError";
  }
}
