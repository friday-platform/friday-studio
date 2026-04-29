import { z } from "zod";

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
      /** OAuth client secret (optional for PKCE / public clients) */
      clientSecret?: string;
      /** Client authentication method for token requests */
      clientAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
      /** Default scopes to request during authorization */
      scopes?: string[];
      /** Additional query parameters for authorization endpoint */
      extraAuthParams?: Record<string, string>;
    }
  | {
      /**
       * Delegated mode: code-for-token exchange happens in an external
       * endpoint (e.g. a Cloud Function holding the client_secret) which
       * then redirects back to the local callback with pre-exchanged
       * tokens in query params.
       *
       * Used to piggyback on a third-party verified OAuth client without
       * shipping its client_secret in this binary. The Friday daemon
       * receives access_token / refresh_token / expiry_date / scope from
       * the callback URL directly — no token endpoint call.
       */
      mode: "delegated";
      /** OAuth authorization endpoint URL (e.g., Google's). */
      authorizationEndpoint: string;
      /**
       * External endpoint that owns the client_secret and performs the
       * code-for-token exchange. This URL is sent to the authorization
       * endpoint as `redirect_uri`. After exchange, this endpoint
       * redirects to the local callback with tokens in query params.
       */
      delegatedExchangeUri: string;
      /**
       * Endpoint to POST to for token refresh. Receives JSON
       * `{refresh_token}`, returns `{access_token, expiry_date,
       * token_type, scope}`. Note: refresh response does NOT include a
       * fresh `refresh_token` — caller must preserve the original.
       */
      delegatedRefreshUri: string;
      /** OAuth client ID. Secret lives in the delegated exchange endpoint. */
      clientId: string;
      /** Default scopes to request during authorization. */
      scopes?: string[];
      /** Additional query parameters for authorization endpoint. */
      extraAuthParams?: Record<string, string>;
      /**
       * Builds the base64-encoded payload that the delegated exchange
       * endpoint expects in the OAuth `state` parameter.
       *
       * The endpoint decodes this payload to learn where to redirect
       * the user after exchange (must be localhost / 127.0.0.1) and
       * what CSRF value to echo back.
       */
      encodeState: (input: {
        /** Opaque token that the exchange endpoint will echo back as `?state=<csrfToken>` on the final redirect. */
        csrfToken: string;
        /** Local URL the exchange endpoint will redirect to with tokens. Must resolve to localhost or 127.0.0.1. */
        finalRedirectUri: string;
      }) => string;
    };

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: number;
};

export type Platform = "slack" | "github";

/** installationId is the single source of truth — tokens are minted fresh from it. */
export const AppInstallCredentialSecretSchema = z.object({
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

export type AppInstallCredentialSecret = z.infer<typeof AppInstallCredentialSecretSchema>;

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

export type HealthResult =
  | { healthy: true; metadata?: Record<string, unknown> }
  | { healthy: false; error: string };

type BaseProviderDefinition = {
  id: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  docsUrl?: string;
};

/**
 * Input for `registerWebhook` / `unregisterWebhook` provider hooks. Symmetric
 * by design — `unregisterWebhook` always receives the same shape so per-platform
 * implementations can choose what they need (Telegram ignores `callbackBaseUrl`
 * on delete, but other platforms may need it to identify the subscription).
 */
export type RegisterWebhookInput = {
  /** Full stored secret post-`autoFields` injection. */
  secret: Record<string, unknown>;
  /** Public tunnel base URL, e.g. `https://<tunnel>` — no trailing slash, no path. */
  callbackBaseUrl: string;
  /** Wiring `connection_id` (kind-specific routing key). */
  connectionId: string;
};

export type ApiKeyProvider = BaseProviderDefinition & {
  readonly type: "apikey";
  readonly setupInstructions: string;
  /**
   * Public, user-facing schema. Describes only the fields the user types into
   * the form. Auto-generated fields (see `autoFields`) are excluded here so the
   * client never sees them in the provider catalog response.
   */
  readonly secretSchema: z.ZodType<Record<string, unknown>>;
  /**
   * Optional server-side hook for fields that should be generated rather than
   * typed by the user (e.g. webhook shared secrets). Called at credential
   * creation time; the returned object is merged into the user-supplied secret
   * with auto-fields overriding user input as a defense-in-depth measure
   * against clients attempting to supply values they shouldn't choose.
   */
  autoFields?(): Record<string, unknown>;
  health?(secret: Record<string, unknown>): Promise<HealthResult>;
  /**
   * Called by Link's `/internal/v1/communicator/wire` AFTER the wiring row has
   * been inserted. The hook constructs the full webhook URL from
   * `${callbackBaseUrl}/platform/${id}/${connectionId}` and registers it with
   * the upstream platform (e.g. Telegram `setWebhook`).
   *
   * Atomicity: if this throws, `/wire` rolls back the wiring insert before
   * returning 500 — a wiring row only exists if the platform accepted the
   * registration. Use Zod for response parsing; never raw `as` casts.
   *
   * Optional. Providers without webhooks (Anthropic etc.) leave it unset and
   * `/wire` is a pure DB insert.
   */
  readonly registerWebhook?: (input: RegisterWebhookInput) => Promise<void>;
  /**
   * Called by Link's `/internal/v1/communicator/disconnect` BEFORE the wiring
   * row is removed. Best-effort: failures log
   * `communicator_webhook_unregister_failed` and disconnect proceeds anyway —
   * user intent is to disconnect, so we don't strand them on platform
   * unreachability.
   */
  readonly unregisterWebhook?: (input: RegisterWebhookInput) => Promise<void>;
};

export function defineApiKeyProvider<TSchema extends z.ZodType<Record<string, unknown>>>(
  provider: Omit<
    ApiKeyProvider,
    "type" | "health" | "autoFields" | "registerWebhook" | "unregisterWebhook"
  > & {
    secretSchema: TSchema;
    autoFields?: () => Record<string, unknown>;
    health?: (secret: z.infer<TSchema>) => Promise<HealthResult>;
    registerWebhook?: (input: RegisterWebhookInput) => Promise<void>;
    unregisterWebhook?: (input: RegisterWebhookInput) => Promise<void>;
  },
): ApiKeyProvider {
  return { type: "apikey", ...provider };
}

export type OAuthProvider = BaseProviderDefinition & {
  readonly type: "oauth";
  readonly oauthConfig: OAuthConfig;
  health?: (tokens: OAuthTokens) => Promise<HealthResult>;
  /** Must return an immutable identifier (e.g., sub claim, not email). */
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

export type AppInstallProvider = BaseProviderDefinition & {
  readonly type: "app_install";
  readonly platform: Platform;
  /** Set to false for providers that handle routing externally (e.g. webhook routing). */
  readonly usesRouteTable?: boolean;
  readonly setupInstructions?: string;

  buildAuthorizationUrl(
    callbackUrl: string,
    state: string,
    context?: { credentialId?: string },
  ): Promise<string>;

  completeInstallation(
    code: string | undefined,
    callbackUrl: string,
    callbackParams?: URLSearchParams,
  ): Promise<AppInstallResult>;

  healthCheck?(secret: AppInstallCredentialSecret): Promise<HealthResult>;

  /**
   * Returns expires_at as absolute unix timestamp (seconds).
   * Throw AppInstallError "NOT_REFRESHABLE" if credential lacks refresh_token.
   */
  refreshToken?(
    secret: AppInstallCredentialSecret,
  ): Promise<{ access_token: string; expires_at: number; refresh_token?: string }>;

  /** Recovery when app is installed but credential is missing (e.g. GitHub App reinstall). */
  completeReinstallation?(installationId: string): Promise<AppInstallResult>;
};

export function defineAppInstallProvider(
  provider: Omit<AppInstallProvider, "type">,
): AppInstallProvider {
  return { type: "app_install", ...provider };
}

export type ProviderDefinition = ApiKeyProvider | OAuthProvider | AppInstallProvider;

/** Wire-safe input for dynamic OAuth providers (discovery mode only). */
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

export const DynamicProviderInputSchema = z.discriminatedUnion("type", [
  DynamicOAuthProviderInputSchema,
  DynamicApiKeyProviderInputSchema,
]);

export type DynamicProviderInput = z.infer<typeof DynamicProviderInputSchema>;
