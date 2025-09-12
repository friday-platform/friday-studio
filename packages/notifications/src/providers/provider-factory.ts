/**
 * Notification provider factory
 */

import type { NotificationProvider as NotificationProviderConfig } from "@atlas/config";
import type { NotificationProvider, NotificationProviderFactory } from "../types.ts";
import { ProviderConfigError } from "../types.ts";
import { SendGridProvider } from "./sendgrid-provider.ts";

/**
 * Default notification provider factory
 */
export class DefaultNotificationProviderFactory implements NotificationProviderFactory {
  /**
   * Create a provider instance from configuration
   */
  create(name: string, config: NotificationProviderConfig): Promise<NotificationProvider> {
    if (!config.enabled) {
      throw new ProviderConfigError(name, "Provider is disabled");
    }

    switch (config.provider) {
      case "sendgrid":
        return Promise.resolve(SendGridProvider.fromConfig(name, config));

      case "slack":
        // TODO: Implement SlackProvider
        throw new ProviderConfigError(name, "Slack provider not yet implemented");

      case "teams":
        // TODO: Implement TeamsProvider
        throw new ProviderConfigError(name, "Teams provider not yet implemented");

      case "discord":
        // TODO: Implement DiscordProvider
        throw new ProviderConfigError(name, "Discord provider not yet implemented");

      default:
        // Type assertion is safe here since we've exhausted all known provider types
        throw new ProviderConfigError(name, `Unknown provider type: ${config.provider}`);
    }
  }

  /**
   * Get supported provider types
   */
  getSupportedTypes(): string[] {
    return ["sendgrid"];
  }
}

/**
 * Provider registry for managing provider factories
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, NotificationProviderFactory>();

  constructor() {
    // Register default factory
    this.registerFactory("default", new DefaultNotificationProviderFactory());
  }

  /**
   * Register a provider factory
   */
  registerFactory(name: string, factory: NotificationProviderFactory): void {
    this.factories.set(name, factory);
  }

  /**
   * Get a provider factory by name
   */
  getFactory(name: string = "default"): NotificationProviderFactory {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Provider factory not found: ${name}`);
    }
    return factory;
  }

  /**
   * Get all supported provider types across all factories
   */
  getSupportedTypes(): string[] {
    const types = new Set<string>();
    for (const factory of this.factories.values()) {
      for (const type of factory.getSupportedTypes()) {
        types.add(type);
      }
    }
    return Array.from(types);
  }

  /**
   * Create a provider instance
   */
  async createProvider(
    name: string,
    config: NotificationProviderConfig,
    factoryName?: string,
  ): Promise<NotificationProvider> {
    const factory = this.getFactory(factoryName);
    return await factory.create(name, config);
  }
}

/**
 * Default provider registry instance
 */
export const defaultProviderRegistry = new ProviderRegistry();
