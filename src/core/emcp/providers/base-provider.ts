/**
 * Base EMCP Provider Implementation
 *
 * Provides common functionality for EMCP providers
 */

import type {
  ContextSpec,
  EMCPContext,
  EMCPCostInfo,
  EMCPProviderConfig,
  EMCPResource,
  EMCPResult,
  IEMCPProvider,
} from "../emcp-provider.ts";

export abstract class BaseEMCPProvider implements IEMCPProvider {
  public abstract readonly config: EMCPProviderConfig;

  protected isInitialized = false;
  protected sourceConfigs: Record<string, unknown> = {};

  /**
   * Initialize provider with workspace configuration
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    this.sourceConfigs = config;
    await this.doInitialize(config);
    this.isInitialized = true;
    console.log(`${this.config.name} provider initialized`);
  }

  /**
   * Subclass-specific initialization
   */
  protected abstract doInitialize(config: Record<string, unknown>): Promise<void>;

  /**
   * Check if provider can handle a specific context type
   */
  canProvide(contextType: string): boolean {
    return this.config.capabilities.some((capability) => capability.type === contextType);
  }

  /**
   * List available resources
   */
  abstract listResources(context: EMCPContext): Promise<EMCPResource[]>;

  /**
   * Read a specific resource
   */
  abstract readResource(uri: string, context: EMCPContext): Promise<EMCPResult>;

  /**
   * Provision context based on specification
   */
  abstract provisionContext(spec: ContextSpec, context: EMCPContext): Promise<EMCPResult>;

  /**
   * Clean up resources and connections
   */
  async shutdown(): Promise<void> {
    await this.doShutdown();
    this.isInitialized = false;
    console.log(`${this.config.name} provider shutdown`);
  }

  /**
   * Subclass-specific shutdown
   */
  protected abstract doShutdown(): Promise<void>;

  // Protected utility methods

  /**
   * Ensure provider is initialized
   */
  protected ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(`Provider ${this.config.name} is not initialized`);
    }
  }

  /**
   * Create a success result
   */
  protected createSuccessResult(
    content?: string | Uint8Array,
    resources?: EMCPResource[],
    cost?: EMCPCostInfo,
    metadata?: Record<string, unknown>,
  ): EMCPResult {
    const result: EMCPResult = {
      success: true,
      cost,
      metadata,
    };

    if (content) {
      return {
        ...result,
        content: {
          uri: "",
          mimeType: "text/plain",
          content,
          metadata,
        },
        resources,
      };
    }

    if (resources) {
      return {
        ...result,
        resources,
      };
    }

    return result;
  }

  /**
   * Create an error result
   */
  protected createErrorResult(
    error: string,
    cost?: EMCPCostInfo,
    metadata?: Record<string, unknown>,
  ): EMCPResult {
    return {
      success: false,
      error,
      cost,
      metadata,
    };
  }

  /**
   * Parse size constraint (e.g., "50kb", "2MB")
   */
  protected parseSize(sizeStr: string): number {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
    if (!match) {
      throw new Error(`Invalid size format: ${sizeStr}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || "b").toLowerCase();

    const multipliers: Record<string, number> = {
      b: 1,
      kb: 1024,
      mb: 1024 * 1024,
      gb: 1024 * 1024 * 1024,
    };

    return value * (multipliers[unit] || 1);
  }

  /**
   * Format content size for display
   */
  protected formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }

  /**
   * Create cost information
   */
  protected createCostInfo(
    processingTimeMs: number,
    dataTransferBytes?: number,
    apiCalls?: number,
  ): EMCPCostInfo {
    return {
      processingTimeMs,
      ...(dataTransferBytes !== undefined && { dataTransferBytes }),
      ...(apiCalls !== undefined && { apiCalls }),
    };
  }

  /**
   * Truncate content to stay within size limits
   */
  protected truncateContent(content: string, maxSize: number): string {
    if (content.length <= maxSize) {
      return content;
    }

    const truncated = content.slice(0, maxSize - 20); // Leave room for suffix
    return truncated + "\n... (truncated)";
  }

  /**
   * Validate context specification
   */
  protected validateContextSpec(spec: ContextSpec, expectedType: string): void {
    if (spec.type !== expectedType) {
      throw new Error(`Expected context type '${expectedType}', got '${spec.type}'`);
    }
  }

  /**
   * Apply timeout to a promise
   */
  protected withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }
}
