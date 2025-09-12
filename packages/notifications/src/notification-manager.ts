/**
 * Notification manager service
 */

import type {
  EmailParams,
  MessageParams,
  NotificationConfig,
  NotificationResult,
} from "@atlas/config";
import { defaultProviderRegistry } from "./providers/provider-factory.ts";
import type {
  NotificationEvent,
  NotificationManagerConfig,
  NotificationProvider,
  ProviderStatus,
  SendNotificationParams,
} from "./types.ts";
import {
  NotificationError,
  NotificationSendError,
  ProviderDisabledError,
  ProviderNotFoundError,
} from "./types.ts";

/**
 * Retry configuration
 */
interface RetryConfig {
  attempts: number;
  delay: number;
  backoff: number;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  attempts: 3,
  delay: 5000, // 5 seconds
  backoff: 2,
};

/**
 * Notification manager handles all notification operations
 */
export class NotificationManager {
  private readonly providers = new Map<string, NotificationProvider>();
  private readonly defaultProvider?: string;
  private readonly retryConfig: RetryConfig;
  private readonly timeout: number;
  private readonly events: NotificationEvent[] = [];

  constructor(config: NotificationManagerConfig) {
    // Store providers
    for (const [name, provider] of Object.entries(config.providers)) {
      this.providers.set(name, provider);
    }

    this.defaultProvider = config.defaultProvider;
    this.retryConfig = config.retryConfig || DEFAULT_RETRY_CONFIG;
    this.timeout = config.timeout !== undefined ? config.timeout : 30000; // 30 seconds default
  }

  /**
   * Create NotificationManager from Atlas configuration
   */
  static async fromConfig(config: NotificationConfig): Promise<NotificationManager> {
    const providers: Record<string, NotificationProvider> = {};

    // Create provider instances
    if (config.providers) {
      for (const [name, providerConfig] of Object.entries(config.providers)) {
        try {
          providers[name] = await defaultProviderRegistry.createProvider(name, providerConfig);
        } catch (error) {
          console.error(`Failed to create provider ${name}:`, error);
          // Continue with other providers
        }
      }
    }

    return new NotificationManager({
      providers,
      defaultProvider: config.defaults?.provider,
      retryConfig: config.defaults
        ? {
            attempts: config.defaults.retry_attempts,
            delay: NotificationManager.parseDuration(config.defaults.retry_delay),
            backoff: config.defaults.retry_backoff,
          }
        : undefined,
      timeout: config.defaults?.timeout
        ? NotificationManager.parseDuration(config.defaults.timeout)
        : undefined,
    });
  }

  /**
   * Send an email notification
   */
  async sendEmail(params: EmailParams, providerName?: string): Promise<NotificationResult> {
    return await this.send({ provider: providerName, type: "email", params });
  }

  /**
   * Send a generic message notification
   */
  async sendMessage(params: MessageParams, providerName?: string): Promise<NotificationResult> {
    return await this.send({ provider: providerName, type: "message", params });
  }

  /**
   * Send a notification with full parameters
   */
  async send(params: SendNotificationParams): Promise<NotificationResult> {
    const startTime = Date.now();
    const eventId = crypto.randomUUID();

    // Determine which provider to use
    const providerName = params.provider || this.defaultProvider;
    if (!providerName) {
      throw new NotificationError(
        "No provider specified and no default provider configured",
        "NO_PROVIDER",
        "none",
      );
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ProviderNotFoundError(providerName);
    }

    if (!provider.enabled) {
      throw new ProviderDisabledError(providerName);
    }

    // Determine retry configuration
    const retryConfig = params.retryConfig || this.retryConfig;
    const timeout = params.timeout !== undefined ? params.timeout : this.timeout;

    // Create event
    const event: NotificationEvent = {
      id: eventId,
      timestamp: new Date(),
      provider: providerName,
      type: params.type,
      status: "success",
      recipient: this.getRecipientInfo(params),
    };

    try {
      // Send notification with retry logic
      const result = await this.sendWithRetry(provider, params, retryConfig, timeout, event);

      // Update event
      event.status = result.success ? "success" : "failure";
      event.duration = Date.now() - startTime;
      event.error = result.error;

      // Store event
      this.events.push(event);

      return result;
    } catch (error) {
      // Update event
      event.status = "failure";
      event.duration = Date.now() - startTime;
      event.error = error instanceof Error ? error.message : String(error);

      // Store event
      this.events.push(event);

      throw error;
    }
  }

  /**
   * Get provider status information
   */
  async getProviderStatus(providerName: string): Promise<ProviderStatus> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ProviderNotFoundError(providerName);
    }

    let healthy = false;
    let error: string | undefined;

    try {
      healthy = await provider.testConnection();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      name: providerName,
      type: provider.type,
      enabled: provider.enabled,
      healthy,
      lastHealthCheck: new Date(),
      error,
    };
  }

  /**
   * Get all provider statuses
   */
  async getAllProviderStatuses(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];

    for (const providerName of this.providers.keys()) {
      try {
        const status = await this.getProviderStatus(providerName);
        statuses.push(status);
      } catch (error) {
        // Add error status for provider
        statuses.push({
          name: providerName,
          type: "unknown",
          enabled: false,
          healthy: false,
          lastHealthCheck: new Date(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return statuses;
  }

  /**
   * Get notification events
   */
  getEvents(limit?: number): NotificationEvent[] {
    const events = [...this.events].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return limit ? events.slice(0, limit) : events;
  }

  /**
   * Get available providers
   */
  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider exists
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Send notification with retry logic
   */
  private async sendWithRetry(
    provider: NotificationProvider,
    params: SendNotificationParams,
    retryConfig: RetryConfig,
    timeout: number,
    event: NotificationEvent,
  ): Promise<NotificationResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retryConfig.attempts; attempt++) {
      try {
        // Send notification with optional timeout
        let result: NotificationResult;
        if (timeout > 0) {
          const attemptTimeout = timeout / (retryConfig.attempts + 1);
          result = await Promise.race([
            this.sendNotification(provider, params),
            this.createTimeoutPromise(attemptTimeout),
          ]);
        } else {
          result = await this.sendNotification(provider, params);
        }

        // Update retry count in result
        result.retry_count = attempt;

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable = error instanceof NotificationSendError ? error.retryable : false;

        // If not retryable or last attempt, throw error
        if (!isRetryable || attempt === retryConfig.attempts) {
          throw lastError;
        }

        // Update event for retry
        event.retryAttempt = attempt + 1;
        event.status = "retry";

        // Wait before retry with exponential backoff
        const delay = retryConfig.delay * retryConfig.backoff ** attempt;
        await this.sleep(delay);
      }
    }

    // Should not reach here, but just in case
    throw lastError || new Error("Unknown error during retry");
  }

  /**
   * Send notification using the appropriate provider method
   */
  private async sendNotification(
    provider: NotificationProvider,
    params: SendNotificationParams,
  ): Promise<NotificationResult> {
    switch (params.type) {
      case "email":
        return await provider.sendEmail(params.params);
      case "message":
        return await provider.sendMessage(params.params);
      default:
        throw new NotificationError(
          `Unsupported notification type: ${params.type}`,
          "UNSUPPORTED_TYPE",
          provider.name,
        );
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeoutPromise(timeout: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Notification timeout after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Get recipient information for logging (anonymized)
   */
  private getRecipientInfo(params: SendNotificationParams): string {
    if (params.type === "email") {
      const emailParams = params.params;
      const recipients = Array.isArray(emailParams.to) ? emailParams.to : [emailParams.to];
      return recipients.map((email) => email.replace(/(.{2}).*@/, "$1***@")).join(", ");
    } else if (params.type === "message") {
      const messageParams = params.params;
      return messageParams.channel || "unknown";
    }
    return "unknown";
  }

  /**
   * Parse duration string to milliseconds
   */
  private static parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid duration unit: ${unit}`);
    }
  }
}
