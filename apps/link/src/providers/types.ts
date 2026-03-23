import { z } from "zod";

/**
 * OAuth configuration discriminated union.
 * - discovery mode: Uses Protected Resource Metadata to find OAuth endpoints
 * - static mode: Pre-configured endpoints for traditional OAuth providers
 */
export type OAuthConfig =
  | {
      /** Discovery mode via Protected Resource Metadata */
      mode: "discovery";
      /** MCP server URL (e.g., https://mcp.atlassian.com/v1/mcp) */
      serverUrl: string;
      /** Default scopes to request during authorization */
      scopes?: string[];
    }
  | {
      /** Static mode with explicit endpoints */
      mode: "static";
      /** OAuth authorization endpoint URL */
      authorizationEndpoint: string;
      /** OAuth token endpoint URL */
      tokenEndpoint: string;
      /** Optional userinfo endpoint URL for identity resolution */
      userinfoEndpoint?: string;
      /** Optional revocation endpoint URL for token revocation (RFC 7009) */
      revocationEndpoint?: string;
      /** OAuth client ID */
      clientId: string;
      /** OAuth client secret */
      clientSecret: string;
      /** Client authentication method for token requests */
      clientAuthMethod?: "client_secret_basic" | "client_secret_post";
      /** Default scopes to request during authorization */
      scopes?: string[];
      /** Additional query parameters for authorization endpoint */
      extraAuthParams?: Record<string, string>;
    };

/**
 * OAuth tokens returned from token endpoint.
 * Used for health checks and API requests.
 */
export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: number;
};

/** Supported platforms for app installation flows. */
export type Platform = "slack" | "github";

/**
 * Zod schema for Slack credential secrets.
 */
const SlackCredentialSecretSchema = z.object({
  platform: z.literal("slack"),
  externalId: z.string(),
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_at: z.number().optional(),
  slack: z
    .object({
      botUserId: z.string(),
      appId: z.string(),
      teamId: z.string(),
      teamName: z.string(),
      scopes: z.array(z.string()),
    })
    .optional(),
});

/**
 * Zod schema for GitHub App credential secrets.
 * Note: installationId is the single source of truth for token minting.
 * No refresh_token needed - we mint fresh tokens from installationId.
 */
const GitHubAppCredentialSecretSchema = z.object({
  platform: z.literal("github"),
  externalId: z.string(),
  access_token: z.string(),
  expires_at: z.number(),
  github: z.object({
    installationId: z.number(),
    organizationName: z.string(),
    organizationId: z.number(),
  }),
});

/**
 * Normalizes legacy credential data by adding the `platform` discriminant.
 *
 * LEGACY DATA HANDLING (added Jan 2026):
 * Before the GitHub App integration, Slack credentials were stored without a
 * `platform` field. With the introduction of the discriminated union for
 * multi-platform support, we need to handle these legacy credentials.
 *
 * Why lazy migration instead of a database migration script:
 * - Credentials are encrypted per-user via Cypher service using user_id as AAD
 * - A migration script cannot decrypt all users' credentials with a single token
 * - Lazy migration runs in the user's auth context where decryption works
 *
 * Detection heuristic:
 * - Missing `platform` field + has `externalId` field = legacy Slack credential
 * - This is safe because GitHub credentials always have `platform: "github"`
 *
 * Cleanup: This preprocessor can be removed once all Slack credentials have been
 * refreshed (tokens expire and get rewritten with the new schema). Monitor for
 * credentials without `platform` field before removing.
 */
function normalizeLegacyCredential(data: unknown): unknown {
  if (typeof data === "object" && data !== null && !("platform" in data) && "externalId" in data) {
    return { ...data, platform: "slack" };
  }
  return data;
}

/**
 * Discriminated union schema for app install credential secrets.
 * Use platform field to discriminate between Slack and GitHub credentials.
 *
 * Includes preprocessing to handle legacy Slack credentials that lack the
 * `platform` field. See `normalizeLegacyCredential` for details.
 */
export const AppInstallCredentialSecretSchema = z.preprocess(
  normalizeLegacyCredential,
  z.discriminatedUnion("platform", [SlackCredentialSecretSchema, GitHubAppCredentialSecretSchema]),
);

/**
 * Base credential secret structure for app install providers.
 * Inferred from AppInstallCredentialSecretSchema.
 */
export type AppInstallCredentialSecret = z.infer<typeof AppInstallCredentialSecretSchema>;

/**
 * Result of completing an app installation flow.
 * Contains external identity and credential to persist.
 */
export type AppInstallResult = {
  readonly externalId: string;
  readonly externalName: string;
  readonly credential: {
    readonly type: "oauth"; // stored as oauth - no DB migration
    readonly provider: string;
    readonly label: string;
    readonly secret: AppInstallCredentialSecret;
  };
};

/**
 * Result of a provider health check.
 * Discriminated union for type-safe handling.
 */
export type HealthResult =
  | { healthy: true; metadata?: Record<string, unknown> }
  | { healthy: false; error: string };

/**
 * Base provider properties shared by all provider types.
 */
type BaseProviderDefinition = {
  /** Unique identifier used in API calls (e.g., "slack", "github") */
  id: string;

  /** Human-readable name for UI display */
  displayName: string;

  /** Short description for list views */
  description: string;

  /** Optional icon URL for UI */
  iconUrl?: string;

  /** Optional documentation URL */
  docsUrl?: string;
};

/**
 * API key provider type.
 * Use `defineApiKeyProvider` factory for type-safe secret inference.
 */
export type ApiKeyProvider = BaseProviderDefinition & {
  /** Authentication type discriminator */
  readonly type: "apikey";

  /** Markdown guide for obtaining credentials */
  readonly setupInstructions: string;

  /** Zod schema defining expected secret shape */
  readonly secretSchema: z.ZodType<Record<string, unknown>>;

  /**
   * Optional health check against upstream service.
   * Called on credential creation and via health endpoint.
   */
  health?(secret: Record<string, unknown>): Promise<HealthResult>;
};

/**
 * Factory for creating API key providers
 *
 * @example
 * ```typescript
 * const myProvider = defineApiKeyProvider({
 *   id: "my-provider",
 *   displayName: "My Provider",
 *   description: "Provider description",
 *   secretSchema: MySecretSchema,
 *   setupInstructions: "...",
 *   async health(secret) {}
 * });
 * ```
 */
export function defineApiKeyProvider<TSchema extends z.ZodType<Record<string, unknown>>>(
  provider: Omit<ApiKeyProvider, "type" | "health"> & {
    secretSchema: TSchema;
    health?: (secret: z.infer<TSchema>) => Promise<HealthResult>;
  },
): ApiKeyProvider {
  return { type: "apikey", ...provider };
}

/**
 * OAuth provider type.
 * Use `defineOAuthProvider` factory for type-safe provider creation.
 */
export type OAuthProvider = BaseProviderDefinition & {
  /** Authentication type discriminator */
  readonly type: "oauth";

  /** OAuth configuration for MCP server connection */
  readonly oauthConfig: OAuthConfig;

  /**
   * Optional health check against upstream service.
   * Called after token acquisition to verify tokens work.
   * Receives validated OAuth tokens, not raw secrets.
   */
  health?: (tokens: OAuthTokens) => Promise<HealthResult>;

  /**
   * Resolves user identity from OAuth tokens.
   * Called after token exchange to get a stable, unique identifier.
   * MUST return an immutable identifier (e.g., sub claim, not email).
   */
  identify: (tokens: OAuthTokens) => Promise<string>;
};

/**
 * Factory for creating OAuth providers
 *
 * @example
 * ```typescript
 * // Discovery mode (MCP OAuth)
 * const mcpProvider = defineOAuthProvider({
 *   id: "atlassian",
 *   displayName: "Atlassian",
 *   description: "Atlassian workspace access via MCP",
 *   oauthConfig: {
 *     mode: "discovery",
 *     serverUrl: "https://mcp.atlassian.com/v1/mcp",
 *     scopes: ["read:jira-work", "write:jira-work"]
 *   },
 *   async health(tokens) {
 *     // tokens is typed as OAuthTokens
 *   }
 * });
 *
 * // Static mode (traditional OAuth)
 * const staticProvider = defineOAuthProvider({
 *   id: "google",
 *   displayName: "Google",
 *   description: "Google Account access",
 *   oauthConfig: {
 *     mode: "static",
 *     authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
 *     tokenEndpoint: "https://oauth2.googleapis.com/token",
 *     clientId: "...",
 *     clientSecret: "...",
 *     scopes: ["openid", "email"]
 *   }
 * });
 * ```
 */
export function defineOAuthProvider(provider: Omit<OAuthProvider, "type">): OAuthProvider {
  return { type: "oauth", ...provider };
}

/**
 * App install provider type.
 * For OAuth apps installed into workspaces (Slack, GitHub, Discord).
 * Use `defineAppInstallProvider` factory for type-safe provider creation.
 */
export type AppInstallProvider = BaseProviderDefinition & {
  /** Authentication type discriminator */
  readonly type: "app_install";

  /** Platform this provider targets */
  readonly platform: Platform;

  /** Markdown guide shown before OAuth flow */
  readonly setupInstructions?: string;

  /**
   * Builds OAuth authorization URL for app installation.
   * Called when user initiates install flow.
   */
  buildAuthorizationUrl(callbackUrl: string, state: string): string;

  /**
   * Completes installation after OAuth callback.
   * Exchanges code for tokens and returns workspace identity + credentials.
   *
   * @param code - OAuth authorization code from callback (may be undefined for special flows)
   * @param callbackUrl - The callback URL used in the authorization request
   * @param callbackParams - Optional URL parameters from callback (e.g., GitHub installation_id)
   * @throws {AppInstallError} For special cases like approval_pending when no code is provided
   */
  completeInstallation(
    code: string | undefined,
    callbackUrl: string,
    callbackParams?: URLSearchParams,
  ): Promise<AppInstallResult>;

  /**
   * Optional health check against upstream service.
   * Called periodically to verify tokens still work.
   */
  healthCheck?(secret: AppInstallCredentialSecret): Promise<HealthResult>;

  /**
   * Optional token refresh implementation.
   * Called when access token is expired or near expiry.
   * Returns updated tokens that should replace the existing credential.
   * Provider returns expires_at as absolute unix timestamp (seconds).
   * Slack returns new refresh_token (token rotation), GitHub doesn't need one.
   *
   * Error handling:
   * - Throw AppInstallError with code "NOT_REFRESHABLE" if credential cannot
   *   be refreshed (e.g., Slack credential missing refresh_token).
   * - Throw other AppInstallError codes for transient failures (network, API errors).
   */
  refreshToken?(
    secret: AppInstallCredentialSecret,
  ): Promise<{ access_token: string; expires_at: number; refresh_token?: string }>;

  /**
   * Optional reinstallation handler for app-level recovery flows.
   * Called when app is already installed but credential is missing (e.g., user
   * deleted credential but app still installed on GitHub org). Uses app-level
   * auth to verify installation and mint token without OAuth code exchange.
   *
   * Currently only applicable to GitHub App installations.
   *
   * @param installationId - Installation ID from callback params (string from URL/DB)
   * @returns Same result as completeInstallation
   */
  completeReinstallation?(installationId: string): Promise<AppInstallResult>;
};

/**
 * Factory for creating app install providers
 *
 * @example
 * ```typescript
 * const slackProvider = defineAppInstallProvider({
 *   id: "slack",
 *   displayName: "Slack",
 *   description: "Install app into Slack workspace",
 *   platform: "slack",
 *   buildAuthorizationUrl(callbackUrl, state) {
 *     return `https://slack.com/oauth/v2/authorize?client_id=...&state=${state}`;
 *   },
 *   async completeInstallation(code, callbackUrl) {
 *     // Exchange code for tokens, return AppInstallResult
 *   },
 *   async healthCheck(secret) {
 *     // Verify tokens still work
 *   }
 * });
 * ```
 */
export function defineAppInstallProvider(
  provider: Omit<AppInstallProvider, "type">,
): AppInstallProvider {
  return { type: "app_install", ...provider };
}

/**
 * Union of all provider definition types.
 * Use the type discriminator to narrow to specific provider type.
 */
export type ProviderDefinition = ApiKeyProvider | OAuthProvider | AppInstallProvider;

// === DYNAMIC PROVIDER INPUT SCHEMAS ===
// Wire-safe types for API/storage. Hydrated to full ProviderDefinition at runtime.

/**
 * Dynamic OAuth provider input (discovery mode only).
 * Static OAuth requires client credentials - use existing static providers.
 */
export const DynamicOAuthProviderInputSchema = z.object({
  type: z.literal("oauth"),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(200),
  oauthConfig: z.object({
    mode: z.literal("discovery"),
    serverUrl: z.httpUrl(),
    scopes: z.array(z.string()).optional(),
  }),
});

export type DynamicOAuthProviderInput = z.infer<typeof DynamicOAuthProviderInputSchema>;

/**
 * Dynamic API key provider input.
 */
export const DynamicApiKeyProviderInputSchema = z.object({
  type: z.literal("apikey"),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(200),
  secretSchema: z.record(z.string(), z.literal("string")).default({ api_key: "string" }),
  setupInstructions: z.string().optional(),
});

export type DynamicApiKeyProviderInput = z.infer<typeof DynamicApiKeyProviderInputSchema>;

/**
 * Union of all dynamic provider inputs.
 */
export const DynamicProviderInputSchema = z.discriminatedUnion("type", [
  DynamicOAuthProviderInputSchema,
  DynamicApiKeyProviderInputSchema,
]);

export type DynamicProviderInput = z.infer<typeof DynamicProviderInputSchema>;
