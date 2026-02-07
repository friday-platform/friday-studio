import { logger } from "@atlas/logger";
// Side-effect import: config.ts has a top-level `await loadEnv()` that populates
// process.env from the DOT_ENV file. This must run before any provider factory
// reads env vars (e.g. GITHUB_APP_ID_FILE). Without this dependency edge, ES module
// evaluation order is non-deterministic between registry.ts and config.ts.
import "../config.ts";
import { anthropicProvider } from "./anthropic.ts";
import { atlassianProvider } from "./atlassian.ts";
import { hydrateDynamicProvider } from "./dynamic.ts";
import { createGitHubAppInstallProvider } from "./github-app.ts";
import {
  createGoogleCalendarProvider,
  createGoogleDocsProvider,
  createGoogleDriveProvider,
  createGoogleGmailProvider,
  createGoogleSheetsProvider,
} from "./google-providers.ts";
import { createHubSpotProvider } from "./hubspot.ts";
import { linearProvider } from "./linear.ts";
import { notionProvider } from "./notion.ts";
import { posthogProvider } from "./posthog.ts";
import { sentryProvider } from "./sentry.ts";
import { createSlackAppInstallProvider } from "./slack-app.ts";
import { getProviderStorageAdapter, type ProviderStorageAdapter } from "./storage/index.ts";
import type { DynamicProviderInput, ProviderDefinition } from "./types.ts";

/**
 * Provider registry.
 * Merges static (built-in) providers with dynamic (storage-backed) providers.
 *
 * Storage is pluggable via ProviderStorageAdapter:
 * - Local: Deno KV for development/single-container
 * - Cloud: Cortex blob storage for persistent cloud deployments
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderDefinition>();
  private storageAdapter: ProviderStorageAdapter | null;

  constructor(storageAdapter?: ProviderStorageAdapter) {
    this.storageAdapter = storageAdapter ?? null;
  }

  /**
   * Lazy init storage adapter.
   * Auto-detects Cortex vs local based on CORTEX_URL environment variable.
   */
  private async getStorageAdapter(): Promise<ProviderStorageAdapter> {
    if (!this.storageAdapter) {
      this.storageAdapter = await getProviderStorageAdapter();
    }
    return this.storageAdapter;
  }

  /**
   * Register a static provider definition.
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
   * Checks static providers first, then storage for dynamic providers.
   * @returns provider definition or undefined if not found
   */
  async get(id: string): Promise<ProviderDefinition | undefined> {
    // Check static providers first
    const staticProvider = this.providers.get(id);
    if (staticProvider) {
      return staticProvider;
    }

    // Check storage for dynamic providers
    const adapter = await this.getStorageAdapter();
    const entry = await adapter.get(id);
    if (entry) {
      return hydrateDynamicProvider(entry);
    }

    return undefined;
  }

  /**
   * Check if a static provider is registered.
   * Only checks static providers (for conflict detection before storing dynamic).
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * List all providers (static + dynamic).
   */
  async list(): Promise<ProviderDefinition[]> {
    const staticProviders = Array.from(this.providers.values());

    const adapter = await this.getStorageAdapter();
    const dynamicEntries = await adapter.list();

    // Filter out any that shadow static providers (shouldn't happen, but defensive)
    const dynamicProviders = dynamicEntries
      .filter((entry) => !this.providers.has(entry.id))
      .map(hydrateDynamicProvider);

    return [...staticProviders, ...dynamicProviders];
  }

  /**
   * Store a dynamic provider to storage atomically.
   * Uses atomic check to prevent race conditions - only succeeds if the provider doesn't exist.
   * Also checks static providers first to prevent shadowing.
   *
   * @returns true if stored successfully, false if provider already exists (static or dynamic)
   */
  async storeDynamicProvider(input: DynamicProviderInput): Promise<boolean> {
    // Check static providers first - can't shadow built-ins
    if (this.providers.has(input.id)) {
      return false;
    }

    const adapter = await this.getStorageAdapter();
    try {
      await adapter.add(input);
      return true;
    } catch (error) {
      // Adapter throws if provider already exists
      if (error instanceof Error && error.message.includes("already exists")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a dynamic provider from storage.
   * Only deletes dynamic providers - static (built-in) providers cannot be deleted.
   *
   * @returns true if deleted, false if not found or is a static provider
   */
  async deleteDynamicProvider(id: string): Promise<boolean> {
    // Don't allow deleting static providers
    if (this.providers.has(id)) {
      return false;
    }

    const adapter = await this.getStorageAdapter();
    return adapter.delete(id);
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

const slackAppProvider = createSlackAppInstallProvider();
if (slackAppProvider) {
  registry.register(slackAppProvider);
} else {
  logger.info(
    "Skipping Slack app install provider: SLACK_APP_CLIENT_ID_FILE or SLACK_APP_CLIENT_SECRET_FILE not set",
  );
}

const githubAppProvider = createGitHubAppInstallProvider();
if (githubAppProvider) {
  registry.register(githubAppProvider);
} else {
  logger.info("Skipping GitHub App provider: env vars not set");
}

// Register built-in providers
registry.register(anthropicProvider);
registry.register(notionProvider);
registry.register(atlassianProvider);
registry.register(linearProvider);
registry.register(sentryProvider);
registry.register(posthogProvider);

const hubspotProvider = createHubSpotProvider();
if (hubspotProvider) {
  registry.register(hubspotProvider);
} else {
  logger.info(
    "Skipping HubSpot provider: HUBSPOT_CLIENT_ID_FILE or HUBSPOT_CLIENT_SECRET_FILE not set",
  );
}
