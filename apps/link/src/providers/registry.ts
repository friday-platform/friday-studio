import { config } from "../config.ts";
import { atlassianProvider } from "./atlassian.ts";
import {
  createGoogleCalendarProvider,
  createGoogleDocsProvider,
  createGoogleDriveProvider,
  createGoogleGmailProvider,
  createGoogleSheetsProvider,
} from "./google-providers.ts";
import { linearProvider } from "./linear.ts";
import { notionProvider } from "./notion.ts";
import { slackProvider } from "./slack.ts";
import { defineApiKeyProvider, type ProviderDefinition } from "./types.ts";

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

// Google Workspace providers (each has its own OAuth scopes)
const googleProviders = [
  createGoogleCalendarProvider(),
  createGoogleGmailProvider(),
  createGoogleDriveProvider(),
  createGoogleDocsProvider(),
  createGoogleSheetsProvider(),
];
for (const provider of googleProviders) {
  if (provider) registry.register(provider);
}

// Register built-in providers
registry.register(slackProvider);
registry.register(notionProvider);
registry.register(atlassianProvider);
registry.register(linearProvider);

// Dev-only test provider for manual testing
if (config.devMode) {
  const { z } = await import("zod");
  registry.register(
    defineApiKeyProvider({
      id: "test",
      displayName: "Test Provider",
      description: "Development-only test provider for manual testing",
      secretSchema: z.object({ key: z.string() }),
      setupInstructions: "Enter any key value for testing.",
    }),
  );
}
