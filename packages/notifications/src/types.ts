/**
 * Core notification types and interfaces
 */

import type {
  EmailParams,
  MessageParams,
  NotificationProvider as NotificationProviderConfig,
  NotificationResult,
} from "@atlas/config";

/**
 * Base notification provider interface
 */
export interface NotificationProvider {
  /**
   * Provider name/identifier
   */
  readonly name: string;

  /**
   * Provider type (matches config provider field)
   */
  readonly type: string;

  /**
   * Whether the provider is enabled
   */
  readonly enabled: boolean;

  /**
   * Send an email notification
   */
  sendEmail(params: EmailParams): Promise<NotificationResult>;

  /**
   * Send a generic message notification
   */
  sendMessage(params: MessageParams): Promise<NotificationResult>;

  /**
   * Validate the provider configuration
   */
  validateConfig(): Promise<boolean>;

  /**
   * Test the provider connection
   */
  testConnection(): Promise<boolean>;
}

/**
 * Provider factory interface
 */
export interface NotificationProviderFactory {
  /**
   * Create a provider instance from configuration
   */
  create(name: string, config: NotificationProviderConfig): Promise<NotificationProvider>;

  /**
   * Get supported provider types
   */
  getSupportedTypes(): string[];
}

/**
 * Notification manager configuration
 */
export interface NotificationManagerConfig {
  /**
   * Available notification providers
   */
  providers: Record<string, NotificationProvider>;

  /**
   * Default provider to use if none specified
   */
  defaultProvider?: string;

  /**
   * Global retry configuration
   */
  retryConfig?: { attempts: number; delay: number; backoff: number };

  /**
   * Global timeout configuration
   */
  timeout?: number;
}

/**
 * Send notification parameters
 */
export interface SendNotificationParams {
  /**
   * Provider name to use (optional, falls back to default)
   */
  provider?: string;

  /**
   * Notification type
   */
  type: "email" | "message";

  /**
   * Notification parameters
   */
  params: EmailParams | MessageParams;

  /**
   * Override retry configuration
   */
  retryConfig?: { attempts: number; delay: number; backoff: number };

  /**
   * Override timeout
   */
  timeout?: number;
}

/**
 * Provider status information
 */
export interface ProviderStatus {
  /**
   * Provider name
   */
  name: string;

  /**
   * Provider type
   */
  type: string;

  /**
   * Whether the provider is enabled
   */
  enabled: boolean;

  /**
   * Whether the provider is healthy
   */
  healthy: boolean;

  /**
   * Last health check timestamp
   */
  lastHealthCheck?: Date;

  /**
   * Error message if unhealthy
   */
  error?: string;
}

/**
 * Notification event for logging/observability
 */
export interface NotificationEvent {
  /**
   * Event ID
   */
  id: string;

  /**
   * Event timestamp
   */
  timestamp: Date;

  /**
   * Provider used
   */
  provider: string;

  /**
   * Notification type
   */
  type: "email" | "message";

  /**
   * Event status
   */
  status: "success" | "failure" | "retry";

  /**
   * Recipient information (anonymized)
   */
  recipient: string;

  /**
   * Duration in milliseconds
   */
  duration?: number;

  /**
   * Error information if failed
   */
  error?: string;

  /**
   * Retry attempt number
   */
  retryAttempt?: number;

  /**
   * Additional metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Notification error types
 */
export class NotificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider: string,
    public readonly retryable: boolean = false,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

export class ProviderConfigError extends NotificationError {
  constructor(provider: string, message: string, originalError?: Error) {
    super(
      `Provider configuration error: ${message}`,
      "PROVIDER_CONFIG_ERROR",
      provider,
      false,
      originalError,
    );
    this.name = "ProviderConfigError";
  }
}

export class ProviderNotFoundError extends NotificationError {
  constructor(provider: string) {
    super(`Provider not found: ${provider}`, "PROVIDER_NOT_FOUND", provider, false);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderDisabledError extends NotificationError {
  constructor(provider: string) {
    super(`Provider disabled: ${provider}`, "PROVIDER_DISABLED", provider, false);
    this.name = "ProviderDisabledError";
  }
}

export class NotificationSendError extends NotificationError {
  constructor(provider: string, message: string, retryable: boolean = true, originalError?: Error) {
    super(
      `Failed to send notification: ${message}`,
      "NOTIFICATION_SEND_ERROR",
      provider,
      retryable,
      originalError,
    );
    this.name = "NotificationSendError";
  }
}

export class NotificationValidationError extends NotificationError {
  constructor(provider: string, message: string, originalError?: Error) {
    super(
      `Validation error: ${message}`,
      "NOTIFICATION_VALIDATION_ERROR",
      provider,
      false,
      originalError,
    );
    this.name = "NotificationValidationError";
  }
}
