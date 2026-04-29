import { readFileSync } from "node:fs";
import { env } from "node:process";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
// Side-effect import: config.ts has a top-level `await loadEnv()` that populates
// process.env from the DOT_ENV file. This must run before any provider factory
// reads env vars (e.g. GITHUB_APP_ID_FILE). Without this dependency edge, ES module
// evaluation order is non-deterministic between registry.ts and config.ts.
import "../config.ts";
import { anthropicProvider } from "./anthropic.ts";
import { atlassianProvider } from "./atlassian.ts";
import { hydrateDynamicProvider } from "./dynamic.ts";
import { githubProvider } from "./github.ts";
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
import { createSlackUserProvider } from "./slack-user.ts";
import { snowflakeProvider } from "./snowflake.ts";
import { getProviderStorageAdapter, type ProviderStorageAdapter } from "./storage/index.ts";
import type { DynamicProviderInput, ProviderDefinition } from "./types.ts";

/** Merges static (built-in) providers with dynamic (storage-backed) providers. */
export class ProviderRegistry {
  private providers = new Map<string, ProviderDefinition>();
  private storageAdapter: ProviderStorageAdapter | null;

  constructor(storageAdapter?: ProviderStorageAdapter) {
    this.storageAdapter = storageAdapter ?? null;
  }

  private async getStorageAdapter(): Promise<ProviderStorageAdapter> {
    if (!this.storageAdapter) {
      this.storageAdapter = await getProviderStorageAdapter();
    }
    return this.storageAdapter;
  }

  register(provider: ProviderDefinition): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  async get(id: string): Promise<ProviderDefinition | undefined> {
    const staticProvider = this.providers.get(id);
    if (staticProvider) {
      return staticProvider;
    }

    const adapter = await this.getStorageAdapter();
    const entry = await adapter.get(id);
    if (entry) {
      return hydrateDynamicProvider(entry);
    }

    return undefined;
  }

  /** Check static providers only (for conflict detection before storing dynamic). */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  async list(): Promise<ProviderDefinition[]> {
    const staticProviders = Array.from(this.providers.values());

    const adapter = await this.getStorageAdapter();
    const dynamicEntries = await adapter.list();

    const dynamicProviders = dynamicEntries
      .filter((entry) => !this.providers.has(entry.id))
      .map(hydrateDynamicProvider);

    return [...staticProviders, ...dynamicProviders];
  }

  /** Store a dynamic provider atomically. Returns false if ID already exists. */
  async storeDynamicProvider(input: DynamicProviderInput): Promise<boolean> {
    if (this.providers.has(input.id)) {
      return false;
    }

    const adapter = await this.getStorageAdapter();
    try {
      await adapter.add(input);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        return false;
      }
      throw error;
    }
  }

  /** Delete a dynamic provider. Static (built-in) providers cannot be deleted. */
  async deleteDynamicProvider(id: string): Promise<boolean> {
    if (this.providers.has(id)) {
      return false;
    }

    const adapter = await this.getStorageAdapter();
    return adapter.delete(id);
  }
}

export const registry = new ProviderRegistry();

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

// The dynamic slack-app provider is registered in index.ts (needs StorageAdapter)
const slackUserProvider = (() => {
  const clientIdFile = env.SLACK_APP_CLIENT_ID_FILE;
  const clientSecretFile = env.SLACK_APP_CLIENT_SECRET_FILE;
  if (!clientIdFile || !clientSecretFile) return undefined;
  try {
    return createSlackUserProvider({
      clientId: readFileSync(clientIdFile, "utf-8").trim(),
      clientSecret: readFileSync(clientSecretFile, "utf-8").trim(),
    });
  } catch (err) {
    logger.warn("slack_user_credential_read_failed", { error: stringifyError(err) });
    return undefined;
  }
})();
if (slackUserProvider) {
  registry.register(slackUserProvider);
} else {
  logger.info(
    "Skipping slack-user provider: SLACK_APP_CLIENT_ID_FILE or SLACK_APP_CLIENT_SECRET_FILE not set",
  );
}

registry.register(githubProvider);

registry.register(anthropicProvider);
registry.register(notionProvider);
registry.register(atlassianProvider);
registry.register(linearProvider);
registry.register(sentryProvider);
registry.register(posthogProvider);
registry.register(snowflakeProvider);

const hubspotProvider = createHubSpotProvider();
if (hubspotProvider) {
  registry.register(hubspotProvider);
} else {
  logger.info(
    "Skipping HubSpot provider: HUBSPOT_CLIENT_ID_FILE or HUBSPOT_CLIENT_SECRET_FILE not set",
  );
}
