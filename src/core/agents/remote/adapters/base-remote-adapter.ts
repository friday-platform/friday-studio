/**
 * Base adapter interface for remote agent communication
 * Provides common abstraction for different protocols (ACP)
 */

import type {
  CircuitBreakerState,
  HealthStatus,
  RemoteAgentInfo,
  RemoteAgentMetrics,
  RemoteAuthConfig,
  RemoteConnectionConfig,
  RemoteExecutionEvent,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteMessagePart,
  RetryConfig,
} from "../types.ts";
import { logger } from "@atlas/logger";

export interface BaseRemoteAdapterConfig {
  connection: RemoteConnectionConfig;
  auth?: RemoteAuthConfig;
  retry?: RetryConfig;
  circuit_breaker?: {
    failure_threshold: number;
    timeout_ms: number;
    half_open_max_calls: number;
  };
  monitoring?: {
    enabled: boolean;
    health_check_interval_ms: number;
  };
}

/**
 * Abstract base class for remote agent adapters
 * Implements common functionality and defines protocol-specific interface
 */
export abstract class BaseRemoteAdapter {
  protected config: BaseRemoteAdapterConfig;
  protected metrics: RemoteAgentMetrics;
  protected circuitBreaker: CircuitBreakerState;
  protected logger = logger.child({ component: "RemoteAdapter" });

  constructor(config: BaseRemoteAdapterConfig) {
    this.config = config;
    this.metrics = this.initializeMetrics();
    this.circuitBreaker = this.initializeCircuitBreaker();
  }

  // Abstract methods that must be implemented by protocol-specific adapters
  abstract getProtocolName(): string;
  abstract discoverAgents(): Promise<RemoteAgentInfo[]>;
  abstract getAgentDetails(agentName: string): Promise<RemoteAgentInfo>;
  abstract executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult>;
  abstract executeAgentStream(
    request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent>;
  abstract cancelExecution(executionId: string): Promise<void>;
  abstract resumeExecution(
    executionId: string,
    response: string | RemoteMessagePart[],
  ): Promise<RemoteExecutionResult>;
  abstract healthCheck(): Promise<HealthStatus>;

  // Common functionality implemented in base class

  /**
   * Get current adapter metrics
   */
  getMetrics(): RemoteAgentMetrics {
    return { ...this.metrics };
  }

  /**
   * Get circuit breaker state
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  /**
   * Check if circuit breaker allows execution
   */
  isCircuitBreakerOpen(): boolean {
    if (this.circuitBreaker.state === "open") {
      const now = new Date();
      if (this.circuitBreaker.next_attempt && now < this.circuitBreaker.next_attempt) {
        return true;
      }
      // Transition to half-open
      this.circuitBreaker.state = "half_open";
      this.logger.info("Circuit breaker transitioning to half-open");
    }
    return false;
  }

  /**
   * Record successful execution for circuit breaker
   */
  protected recordSuccess(latencyMs: number): void {
    this.metrics.total_requests++;
    this.metrics.successful_requests++;
    this.updateAverageLatency(latencyMs);

    // Reset circuit breaker on success
    if (this.circuitBreaker.state !== "closed") {
      this.circuitBreaker.state = "closed";
      this.circuitBreaker.failure_count = 0;
      this.logger.info("Circuit breaker closed after successful execution");
    }
  }

  /**
   * Record failed execution for circuit breaker
   */
  protected recordFailure(_error: Error): void {
    this.metrics.total_requests++;
    this.metrics.failed_requests++;

    this.circuitBreaker.failure_count++;
    this.circuitBreaker.last_failure = new Date();

    const threshold = this.config.circuit_breaker?.failure_threshold || 5;
    if (this.circuitBreaker.failure_count >= threshold) {
      this.openCircuitBreaker();
    }
  }

  /**
   * Open circuit breaker and set next attempt time
   */
  private openCircuitBreaker(): void {
    this.circuitBreaker.state = "open";
    const timeoutMs = this.config.circuit_breaker?.timeout_ms || 60000;
    this.circuitBreaker.next_attempt = new Date(Date.now() + timeoutMs);

    this.logger.warn("Circuit breaker opened", {
      failure_count: this.circuitBreaker.failure_count,
      next_attempt: this.circuitBreaker.next_attempt,
    });
  }

  /**
   * Update average latency metric
   */
  private updateAverageLatency(latencyMs: number): void {
    const totalRequests = this.metrics.total_requests;
    const currentAverage = this.metrics.average_latency_ms;

    // Calculate new average using running average formula
    this.metrics.average_latency_ms = ((currentAverage * (totalRequests - 1)) + latencyMs) /
      totalRequests;
  }

  /**
   * Initialize metrics with default values
   */
  private initializeMetrics(): RemoteAgentMetrics {
    return {
      total_requests: 0,
      successful_requests: 0,
      failed_requests: 0,
      average_latency_ms: 0,
      circuit_breaker_state: this.initializeCircuitBreaker(),
    };
  }

  /**
   * Initialize circuit breaker with default state
   */
  private initializeCircuitBreaker(): CircuitBreakerState {
    return {
      state: "closed",
      failure_count: 0,
    };
  }

  /**
   * Create authenticated fetch function based on auth config
   */
  protected createAuthenticatedFetch(): typeof fetch {
    return async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      // Add authentication based on config
      if (this.config.auth) {
        this.addAuthenticationHeaders(headers);
      }

      // Add default headers
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", "Atlas-Remote-Agent/1.0");

      // Set timeout
      const timeout = this.config.connection.timeout || 30000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    };
  }

  /**
   * Add authentication headers based on configuration
   */
  private addAuthenticationHeaders(headers: Headers): void {
    const auth = this.config.auth!;

    switch (auth.type) {
      case "bearer": {
        const token = this.getAuthToken(auth.token_env, auth.token);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        break;
      }
      case "api_key": {
        const apiKey = this.getAuthToken(auth.api_key_env, auth.api_key);
        if (apiKey) {
          const headerName = auth.header || "X-API-Key";
          headers.set(headerName, apiKey);
        }
        break;
      }
      case "basic": {
        if (auth.username && auth.password) {
          const credentials = btoa(`${auth.username}:${auth.password}`);
          headers.set("Authorization", `Basic ${credentials}`);
        }
        break;
      }
      case "none":
        // No authentication needed
        break;
      default:
        this.logger.warn("Unknown authentication type", { type: auth.type });
    }
  }

  /**
   * Get authentication token from environment or direct value
   */
  private getAuthToken(envVar?: string, directValue?: string): string | undefined {
    if (envVar) {
      const token = Deno.env.get(envVar);
      if (!token) {
        this.logger.warn("Authentication environment variable not found", { envVar });
      }
      return token;
    }
    return directValue;
  }

  /**
   * Execute with retry logic and circuit breaker protection
   */
  protected async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      throw new Error(`Circuit breaker is open for ${operationName}`);
    }

    const retryConfig = this.config.retry || {
      max_attempts: 3,
      base_delay_ms: 1000,
      max_delay_ms: 10000,
      backoff_multiplier: 2,
    };

    let lastError: Error;
    const startTime = performance.now();

    for (let attempt = 1; attempt <= retryConfig.max_attempts; attempt++) {
      try {
        const result = await operation();
        const latency = performance.now() - startTime;
        this.recordSuccess(latency);
        return result;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on final attempt
        if (attempt === retryConfig.max_attempts) {
          break;
        }

        // Check if error is retryable
        if (!this.isRetryableError(lastError, retryConfig)) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          retryConfig.base_delay_ms * Math.pow(retryConfig.backoff_multiplier, attempt - 1),
          retryConfig.max_delay_ms,
        );

        this.logger.info("Retrying operation", {
          operationName,
          attempt,
          delay,
          error: lastError.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All attempts failed
    this.recordFailure(lastError!);
    throw lastError!;
  }

  /**
   * Check if error should trigger a retry
   */
  private isRetryableError(error: Error, retryConfig: RetryConfig): boolean {
    // If specific retryable errors are configured, check against them
    if (retryConfig.retryable_errors && retryConfig.retryable_errors.length > 0) {
      return retryConfig.retryable_errors.some((pattern) =>
        error.message.includes(pattern) || error.name.includes(pattern)
      );
    }

    // Default retryable conditions
    return (
      error.name === "NetworkError" ||
      error.name === "TimeoutError" ||
      error.message.includes("timeout") ||
      error.message.includes("connection") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ENOTFOUND")
    );
  }

  /**
   * Validate execution request
   */
  protected validateRequest(request: RemoteExecutionRequest): void {
    if (!request.agentName) {
      throw new Error("Agent name is required");
    }
    if (!request.input) {
      throw new Error("Input is required");
    }
    if (!["sync", "async", "stream"].includes(request.mode)) {
      throw new Error("Invalid execution mode");
    }
  }

  /**
   * Dispose of adapter resources
   */
  dispose(): void {
    // Cleanup resources, stop health checks, etc.
    this.logger.info("Remote adapter disposed");
  }
}
