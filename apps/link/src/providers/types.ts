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
      /** MCP server URL (e.g., https://mcp.atlassian.com/v1/sse) */
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

/**
 * Supported platforms for app installation flows.
 * Currently Slack only, will expand to GitHub, Discord, etc.
 */
export type Platform = "slack";

/**
 * Zod schema for app install credential secrets.
 * Contains OAuth tokens and routing key for multi-tenant apps.
 */
export const AppInstallCredentialSecretSchema = z.object({
  externalId: z.string(), // Routing key (team_id, guild_id)
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_at: z.number().optional(),
});

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
 *     serverUrl: "https://mcp.atlassian.com/v1/sse",
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
   */
  completeInstallation(code: string, callbackUrl: string): Promise<AppInstallResult>;

  /**
   * Optional health check against upstream service.
   * Called periodically to verify tokens still work.
   */
  healthCheck?(secret: AppInstallCredentialSecret): Promise<HealthResult>;

  /**
   * Optional token refresh implementation.
   * Called when access token is expired or near expiry.
   * Returns updated tokens that should replace the existing credential.
   * Provider is responsible for accessing its own client credentials.
   */
  refreshToken?(
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
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
