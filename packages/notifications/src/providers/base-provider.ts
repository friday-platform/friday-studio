/**
 * Base notification provider implementation
 */

import type { EmailParams, MessageParams, NotificationResult } from "@atlas/config";
import type { NotificationProvider } from "../types.ts";
import { NotificationError, ProviderConfigError } from "../types.ts";

/**
 * Base configuration for all providers
 */
export interface BaseProviderConfig {
  /**
   * Whether the provider is enabled
   */
  enabled: boolean;

  /**
   * Provider description
   */
  description?: string;

  /**
   * Request timeout in milliseconds
   */
  timeout?: number;
}

/**
 * Abstract base class for notification providers
 */
export abstract class BaseNotificationProvider implements NotificationProvider {
  public readonly name: string;
  public readonly type: string;
  public readonly enabled: boolean;
  protected readonly config: BaseProviderConfig;

  constructor(name: string, type: string, config: BaseProviderConfig) {
    this.name = name;
    this.type = type;
    this.enabled = config.enabled;
    this.config = config;
  }

  /**
   * Send an email notification
   */
  abstract sendEmail(params: EmailParams): Promise<NotificationResult>;

  /**
   * Send a generic message notification
   */
  abstract sendMessage(params: MessageParams): Promise<NotificationResult>;

  /**
   * Validate the provider configuration
   */
  abstract validateConfig(): Promise<boolean>;

  /**
   * Test the provider connection
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * Get environment variable value
   */
  protected getEnvVar(envVar: string): string {
    const value = Deno.env.get(envVar);
    if (!value) {
      throw new ProviderConfigError(this.name, `Environment variable ${envVar} is not set`);
    }
    return value;
  }

  /**
   * Create success response
   */
  protected createSuccessResponse(
    messageId?: string,
    metadata?: Record<string, unknown>,
  ): NotificationResult {
    return { success: true, message_id: messageId, metadata };
  }

  /**
   * Create error response
   */
  protected createErrorResponse(
    error: string,
    retryCount?: number,
    metadata?: Record<string, unknown>,
  ): NotificationResult {
    return { success: false, error, retry_count: retryCount, metadata };
  }

  /**
   * Handle provider errors and convert to NotificationError
   */
  protected handleError(error: unknown, operation: string): NotificationError {
    if (error instanceof NotificationError) {
      return error;
    }

    if (error instanceof Error) {
      return new NotificationError(
        `${operation} failed: ${error.message}`,
        "PROVIDER_ERROR",
        this.name,
        this.isRetryableError(error),
        error,
      );
    }

    return new NotificationError(
      `${operation} failed: ${String(error)}`,
      "PROVIDER_ERROR",
      this.name,
      false,
    );
  }

  /**
   * Determine if an error is retryable
   * Override in subclasses for provider-specific logic
   */
  protected isRetryableError(error: Error): boolean {
    // Default implementation - consider network errors retryable
    return (
      error.name === "NetworkError" ||
      error.name === "TimeoutError" ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("ETIMEDOUT")
    );
  }

  /**
   * Validate common email parameters
   */
  protected validateEmailParams(params: EmailParams): void {
    if (!params.to) {
      throw new ProviderConfigError(this.name, "Missing required parameter: to");
    }
    if (!params.subject) {
      throw new ProviderConfigError(this.name, "Missing required parameter: subject");
    }
    if (!params.content) {
      throw new ProviderConfigError(this.name, "Missing required parameter: content");
    }

    // Validate email addresses
    const recipients = Array.isArray(params.to) ? params.to : [params.to];
    for (const email of recipients) {
      if (!this.isValidEmail(email)) {
        throw new ProviderConfigError(this.name, `Invalid email address: ${email}`);
      }
    }

    if (params.from && !this.isValidEmail(params.from)) {
      throw new ProviderConfigError(this.name, `Invalid from email address: ${params.from}`);
    }
  }

  /**
   * Validate common message parameters
   */
  protected validateMessageParams(params: MessageParams): void {
    if (!params.content) {
      throw new ProviderConfigError(this.name, "Missing required parameter: content");
    }
  }

  /**
   * Basic email validation
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Get timeout from config or default
   */
  protected getTimeout(): number {
    return this.config.timeout ?? 30000; // 30 seconds default
  }
}
