import { logger } from "@atlas/logger";
import { createGoogleProvider } from "./google.ts";
import { notionProvider } from "./notion.ts";
import { slackProvider } from "./slack.ts";
import type { ProviderDefinition } from "./types.ts";

/**
 * Provider registry.
 * Simple Map wrapper with registration validation.
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderDefinition>();

  /**
   * Register a provider definition.
   * @throws {Error} if provider ID is already registered
   */
  register(provider: ProviderDefinition): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Get a provider by ID.
   * @returns provider definition or undefined if not found
   */
  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }

  /**
   * Check if a provider is registered.
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * List all registered providers.
   */
  list(): ProviderDefinition[] {
    return Array.from(this.providers.values());
  }
}

/**
 * Singleton registry instance for app-wide use.
 * Tests should create their own instances, not use this singleton.
 */
export const registry = new ProviderRegistry();

const googleProvider = createGoogleProvider();
if (googleProvider) {
  registry.register(googleProvider);
} else {
  logger.info("Skipping Google provider: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set");
}

// Register built-in providers
registry.register(slackProvider);
registry.register(notionProvider);
