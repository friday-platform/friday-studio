/**
 * Error Handling and Fallback Strategies for MECMF
 *
 * Implements robust error handling based on MECMF Section 3.4, providing graceful
 * degradation when memory operations encounter failures or resource constraints.
 */

import type { FailureRecoveryStrategies, MemoryType } from "./mecmf-interfaces.ts";

export interface ErrorDetails {
  error?: string;
  attempt?: number;
  timeout?: number;
  primaryError?: string;
  usedFallback?: string;
}

export interface ErrorStatistic {
  total: number;
  recent: number;
  errorTypes: string[];
  lastError: Date | null;
}

export interface ErrorContext {
  operation: string;
  memoryType?: MemoryType;
  errorType: string;
  timestamp: Date;
  retryCount: number;
  details?: ErrorDetails;
}

export interface FallbackResult<T> {
  data: T;
  usedFallback: boolean;
  fallbackMethod?: string;
  originalError?: Error;
  performanceImpact: "none" | "minimal" | "moderate" | "significant";
}

export interface ResourceMetrics {
  memoryUsage: number;
  diskUsage: number;
  vectorIndexSize: number;
  cacheSize: number;
  lastUpdated: Date;
}

export interface EmergencyPruneResult {
  memoriesRemoved: number;
  spaceReclaimed: number;
  backupCreated: boolean;
  prunedTypes: Record<MemoryType, number>;
}

export class MECMFErrorHandler {
  private readonly recoveryStrategies: FailureRecoveryStrategies;
  private readonly errorHistory: Map<string, ErrorContext[]> = new Map();
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();

  constructor() {
    this.recoveryStrategies = {
      embedding_service_down: {
        fallback: "text-based keyword search",
        timeout: "5 seconds",
        retry_attempts: 3,
      },
      storage_capacity_exceeded: {
        action: "emergency_pruning_with_backup",
        threshold: "90% capacity",
        recovery_target: "70% capacity",
      },
      vector_search_timeout: {
        fallback: "cached_recent_memories",
        timeout_threshold: "500ms",
        cache_size: 50,
      },
      memory_corruption: {
        recovery: "restore_from_checkpoint",
        checkpoint_interval: "1 hour",
        validation_checks: true,
      },
    };
  }

  /**
   * Handle embedding service failures with fallback to text search
   */
  async handleEmbeddingFailure<T>(
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    context: Partial<ErrorContext> = {},
  ): Promise<FallbackResult<T>> {
    const maxRetries = this.recoveryStrategies.embedding_service_down.retry_attempts;
    const timeout = 5000; // 5 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.withTimeout(operation, timeout);

        // Success - reset circuit breaker if it exists
        const circuitBreaker = this.circuitBreakers.get("embedding_service");
        if (circuitBreaker) {
          circuitBreaker.reset();
        }

        return { data: result, usedFallback: false, performanceImpact: "none" };
      } catch (error) {
        this.recordError({
          operation: context.operation || "embedding_operation",
          errorType: "embedding_service_failure",
          timestamp: new Date(),
          retryCount: attempt,
          details: { error: error.message, attempt },
          ...context,
        });

        // If this is the last attempt, use fallback
        if (attempt === maxRetries) {
          try {
            const fallbackResult = await fallbackOperation();

            // Update circuit breaker
            this.getOrCreateCircuitBreaker("embedding_service").recordFailure();

            return {
              data: fallbackResult,
              usedFallback: true,
              fallbackMethod: "text-based keyword search",
              originalError: error as Error,
              performanceImpact: "moderate",
            };
          } catch (_fallbackError) {
            throw new Error(
              `Primary operation failed: ${error.message}. Fallback also failed: ${fallbackError.message}`,
            );
          }
        }

        // Wait before retry (exponential backoff)
        await this.sleep(2 ** attempt * 100);
      }
    }

    throw new Error("This should never be reached");
  }

  /**
   * Handle vector search timeouts with cached fallback
   */
  async handleVectorSearchTimeout<T>(
    searchOperation: () => Promise<T[]>,
    getCachedMemories: (limit: number) => Promise<T[]>,
    context: Partial<ErrorContext> = {},
  ): Promise<FallbackResult<T[]>> {
    const timeout = 500; // 500ms as specified in MECMF
    const cacheSize = this.recoveryStrategies.vector_search_timeout.cache_size;

    try {
      const result = await this.withTimeout(searchOperation, timeout);
      return { data: result, usedFallback: false, performanceImpact: "none" };
    } catch (error) {
      this.recordError({
        operation: context.operation || "vector_search",
        errorType: "vector_search_timeout",
        timestamp: new Date(),
        retryCount: 1,
        details: { timeout, error: error.message },
        ...context,
      });

      try {
        const cachedResult = await getCachedMemories(cacheSize);
        return {
          data: cachedResult,
          usedFallback: true,
          fallbackMethod: "cached_recent_memories",
          originalError: error as Error,
          performanceImpact: "minimal",
        };
      } catch (_cacheError) {
        return {
          data: [],
          usedFallback: true,
          fallbackMethod: "empty_result",
          originalError: error as Error,
          performanceImpact: "significant",
        };
      }
    }
  }

  /**
   * Handle storage capacity exceeded with emergency pruning
   */
  async handleStorageCapacityExceeded(
    _getCurrentUsage: () => Promise<ResourceMetrics>,
    performEmergencyPrune: (targetPercentage: number) => Promise<EmergencyPruneResult>,
    createBackup: () => Promise<boolean>,
    context: Partial<ErrorContext> = {},
  ): Promise<EmergencyPruneResult> {
    this.recordError({
      operation: context.operation || "storage_operation",
      errorType: "storage_capacity_exceeded",
      timestamp: new Date(),
      retryCount: 1,
      ...context,
    });

    // Create backup first
    let backupCreated = false;
    try {
      backupCreated = await createBackup();
    } catch (_backupError) {
      // Continue with pruning anyway as storage is critical
    }

    // Perform emergency pruning to reach 70% capacity target
    const targetPercentage = 0.7;

    try {
      const pruneResult = await performEmergencyPrune(targetPercentage);

      return { ...pruneResult, backupCreated };
    } catch (pruneError) {
      throw new Error(
        `Storage capacity exceeded and emergency pruning failed: ${pruneError.message}`,
      );
    }
  }

  /**
   * Handle memory corruption with checkpoint restoration
   */
  async handleMemoryCorruption<T>(
    validateMemory: () => Promise<boolean>,
    restoreFromCheckpoint: () => Promise<T>,
    context: Partial<ErrorContext> = {},
  ): Promise<T> {
    this.recordError({
      operation: context.operation || "memory_operation",
      errorType: "memory_corruption",
      timestamp: new Date(),
      retryCount: 1,
      ...context,
    });

    // Validate current memory state
    try {
      const isValid = await validateMemory();
      if (isValid) {
        throw new Error("Memory validation unexpectedly passed");
      }
    } catch (_validationError) {
      // Memory validation confirmed corruption, proceeding with restoration
    }

    // Restore from checkpoint
    try {
      const restored = await restoreFromCheckpoint();
      return restored;
    } catch (restoreError) {
      throw new Error(`Memory corruption detected and restoration failed: ${restoreError.message}`);
    }
  }

  /**
   * Monitor resource usage and trigger preventive measures
   */
  async monitorResourceUsage(
    getResourceMetrics: () => Promise<ResourceMetrics>,
    onMemoryPressure: (severity: "warning" | "emergency") => Promise<void>,
    onDiskPressure: (severity: "warning" | "emergency") => Promise<void>,
  ): Promise<void> {
    try {
      const metrics = await getResourceMetrics();

      // Check memory pressure
      if (metrics.memoryUsage >= 0.95) {
        await onMemoryPressure("emergency");
      } else if (metrics.memoryUsage >= 0.85) {
        await onMemoryPressure("warning");
      }

      // Check disk pressure
      if (metrics.diskUsage >= 0.98) {
        await onDiskPressure("emergency");
      } else if (metrics.diskUsage >= 0.9) {
        await onDiskPressure("warning");
      }
    } catch (_error) {
      // Don't throw - resource monitoring shouldn't break the main flow
    }
  }

  /**
   * Graceful degradation for memory operations
   */
  async withGracefulDegradation<T>(
    primaryOperation: () => Promise<T>,
    fallbackOperations: Array<{
      name: string;
      operation: () => Promise<T>;
      performanceImpact: FallbackResult<T>["performanceImpact"];
    }>,
    context: Partial<ErrorContext> = {},
  ): Promise<FallbackResult<T>> {
    // Try primary operation first
    try {
      const result = await primaryOperation();
      return { data: result, usedFallback: false, performanceImpact: "none" };
    } catch (primaryError) {
      // Try fallback operations in order
      for (const fallback of fallbackOperations) {
        try {
          const result = await fallback.operation();

          this.recordError({
            operation: context.operation || "graceful_degradation",
            errorType: "primary_operation_failure",
            timestamp: new Date(),
            retryCount: 1,
            details: { primaryError: primaryError.message, usedFallback: fallback.name },
            ...context,
          });

          return {
            data: result,
            usedFallback: true,
            fallbackMethod: fallback.name,
            originalError: primaryError as Error,
            performanceImpact: fallback.performanceImpact,
          };
        } catch (_fallbackError) {}
      }

      // All operations failed
      throw new Error(`All operations failed. Primary: ${primaryError.message}`);
    }
  }

  /**
   * Get error statistics for monitoring
   */
  getErrorStatistics(): Record<string, ErrorStatistic> {
    const stats: Record<string, ErrorStatistic> = {};

    for (const [operation, errors] of this.errorHistory.entries()) {
      const recentErrors = errors.filter(
        (e) => Date.now() - e.timestamp.getTime() < 24 * 60 * 60 * 1000, // Last 24 hours
      );

      stats[operation] = {
        total: errors.length,
        recent: recentErrors.length,
        errorTypes: [...new Set(errors.map((e) => e.errorType))],
        lastError: errors[errors.length - 1]?.timestamp || null,
      };
    }

    return stats;
  }

  /**
   * Clear error history (useful for testing)
   */
  clearErrorHistory(): void {
    this.errorHistory.clear();
    this.circuitBreakers.clear();
  }

  // Private helper methods

  private async withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: number | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      const result = await Promise.race([operation(), timeoutPromise]);

      // Clear the timeout if the operation completed successfully
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      return result;
    } catch (error) {
      // Clear the timeout on error as well
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private recordError(error: ErrorContext): void {
    const operation = error.operation;

    if (!this.errorHistory.has(operation)) {
      this.errorHistory.set(operation, []);
    }

    const errors = this.errorHistory.get(operation)!;
    errors.push(error);

    // Keep only the last 100 errors per operation
    if (errors.length > 100) {
      errors.splice(0, errors.length - 100);
    }
  }

  private getOrCreateCircuitBreaker(name: string): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(
        name,
        new CircuitBreaker({
          failureThreshold: 5,
          resetTimeout: 60000, // 1 minute
        }),
      );
    }
    return this.circuitBreakers.get(name)!;
  }
}

/**
 * Simple Circuit Breaker implementation
 */
class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failureCount = 0;
  private lastFailureTime?: Date;

  constructor(private options: { failureThreshold: number; resetTimeout: number }) {}

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = "open";
    }
  }

  reset(): void {
    this.failureCount = 0;
    this.state = "closed";
    this.lastFailureTime = undefined;
  }

  canExecute(): boolean {
    if (this.state === "closed") {
      return true;
    }

    if (this.state === "open" && this.lastFailureTime) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime.getTime();
      if (timeSinceLastFailure >= this.options.resetTimeout) {
        this.state = "half-open";
        return true;
      }
      return false;
    }

    return this.state === "half-open";
  }

  getState(): string {
    return this.state;
  }
}

// Factory function
export function createErrorHandler(): MECMFErrorHandler {
  return new MECMFErrorHandler();
}
