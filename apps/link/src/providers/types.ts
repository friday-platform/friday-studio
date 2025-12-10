import type { z } from "zod";

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
 * Union of all provider definition types.
 * Use the type discriminator to narrow to specific provider type.
 */
export type ProviderDefinition = ApiKeyProvider | OAuthProvider;
