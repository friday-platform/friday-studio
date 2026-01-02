# Slack App Install Flow Design

**Date:** 2025-12-16

**Status:** Draft (v4 - simplified routing, no signal-gateway changes)

**Author:** Eric Skram + Claude

## Overview

Extend Link to support OAuth-based app installation flows, starting with Slack.
After a successful install, Link stores the credential and registers the route
so signal-gateway can route incoming Slack events to the correct Atlas instance.

## Goals

1. Allow users to install the Atlas Slack App into their workspace via OAuth
2. Store bot token credentials (for future Atlas → Slack API communication)
3. Register platform routes for signal-gateway → Atlas event routing
4. Keep it simple - no signal-gateway changes, no schema migrations

## Design

### Provider Type

Add `AppInstallProvider` as a third discriminated union member in
`providers/types.ts`:

```typescript
/**
 * Platform identifier for app installations.
 * Used for routing Slack events to correct Atlas instances.
 */
// later will include GitHub / Discord / ...
type Platform = "slack";

/**
 * App install provider for OAuth-based platform integrations.
 * Unlike OAuthProvider (user auth), this installs an app into a workspace/org/guild.
 */
type AppInstallProvider = BaseProviderDefinition & {
  readonly type: "app_install";
  readonly platform: Platform;

  /** Build the platform's authorization URL */
  buildAuthorizationUrl(callbackUrl: string, state: string): string;

  /**
   * Exchange code for installation data.
   * Returns storage-ready credential input - provider owns validation.
   */
  completeInstallation(
    code: string,
    callbackUrl: string,
  ): Promise<AppInstallResult>;

  /** Optional health check */
  healthCheck?(secret: AppInstallCredentialSecret): Promise<HealthResult>;
};

/**
 * Result of completing an app installation.
 * Provider returns storage-ready credential - no Record<string, unknown>.
 */
type AppInstallResult = {
  readonly externalId: string; // Routing key (team_id, guild_id, installation_id)
  readonly externalName: string; // Display name for UI
  readonly credential: {
    readonly type: "oauth";
    readonly provider: string;
    readonly label: string;
    readonly secret: AppInstallCredentialSecret;
  };
};

/**
 * Base shape for all app install credential secrets.
 * Platform-specific fields go in nested objects.
 */
type AppInstallCredentialSecret = {
  readonly externalId: string; // Always present - routing key, platform-agnostic
  readonly access_token: string;
  readonly token_type: string;
  readonly refresh_token?: string;
  readonly expires_at?: number;
};

/**
 * Slack-specific credential secret shape.
 * Extends base with Slack-specific nested fields.
 *
 * Note: teamId appears twice - externalId (platform-agnostic routing key used by
 * reconcileRoute) and slack.teamId (Slack-specific for display/debugging).
 */
type SlackCredentialSecret = AppInstallCredentialSecret & {
  readonly token_type: "bot";
  readonly slack: {
    readonly botUserId: string;
    readonly appId: string;
    readonly teamId: string;
    readonly teamName: string;
    readonly scopes: readonly string[];
  };
};

// Updated union
type ProviderDefinition = ApiKeyProvider | OAuthProvider | AppInstallProvider;
```

Factory function:

```typescript
function defineAppInstallProvider(
  provider: Omit<AppInstallProvider, "type">,
): AppInstallProvider {
  return { type: "app_install", ...provider };
}
```

### Storage

Two things get stored after a successful install:

**1. Installation credential** (via existing `StorageAdapter`, stored as
`type: "oauth"`)

Storing as `type: "oauth"` avoids DB migration. The provider ID (`slack-app` vs
`slack`) is the discriminator.

```typescript
{
  type: "oauth",
  provider: "slack-app",
  label: "Acme Corp Workspace",
  secret: {
    externalId: "T024BE7LD",         // Always present - used for re-install detection
    access_token: "xoxb-...",
    token_type: "bot",
    refresh_token: "xoxe-1-...",     // optional, if token rotation enabled
    expires_at: 1734364800,          // optional, if token rotation enabled
    slack: {
      botUserId: "U0KRQLJ9H",
      appId: "A0KRD7HC3",
      teamId: "T024BE7LD",
      teamName: "Acme Corp",
      scopes: ["chat:write", "channels:history", "channels:read", "app_mentions:read"],
    },
  },
}
```

**2. Platform route** (existing `platform_route` table)

```sql
-- Uses existing schema: team_id, user_id
INSERT INTO platform_route (team_id, user_id)
VALUES ('T024BE7LD', 'user-123')
ON CONFLICT (team_id)
DO UPDATE SET user_id = EXCLUDED.user_id
```

No schema changes required. Signal-gateway's existing query works unchanged:
`SELECT user_id FROM platform_route WHERE team_id = $1`

### PlatformRouteRepository Interface

Minimal contract for routing:

```typescript
/**
 * Repository interface for platform route storage.
 * Routes team_id → user_id for signal-gateway event routing.
 */
interface PlatformRouteRepository {
  /**
   * Find route by team ID.
   * Used to check if a team is already registered.
   */
  findByTeamId(teamId: string): Promise<{ userId: string } | null>;

  /**
   * Upsert a platform route.
   * If team_id exists, update user_id.
   */
  upsert(teamId: string, userId: string): Promise<void>;
}
```

### StorageAdapter Extension

For idempotent re-installs, add method to find existing credentials:

```typescript
interface StorageAdapter {
  // ... existing methods ...

  /**
   * Find credential by provider and external ID.
   * Used for re-install detection - updates existing credential instead of creating new.
   */
  findByProviderAndExternalId(
    provider: string,
    externalId: string,
    userId: string,
  ): Promise<Credential | null>;
}
```

This queries credentials where `secret.externalId` matches, enabling re-install
detection without coupling routes to credentials.

### Routes

New routes mounted at `/v1/app-install`:

| Method | Path                                  | Description                                          |
| ------ | ------------------------------------- | ---------------------------------------------------- |
| GET    | `/v1/app-install/:provider/authorize` | Initiate install flow, redirect to platform auth     |
| GET    | `/v1/app-install/callback`            | Handle OAuth callback from all app_install providers |
| POST   | `/v1/app-install/:provider/reconcile` | Re-upsert route for existing credential (recovery)   |

Query parameters for `/authorize`:

- `redirect_uri` — Where to send user after successful install (optional)

Callback parameters vary by platform but always include `code` and `state`.

### AppInstallService

New service class orchestrating the install flow:

```typescript
class AppInstallService {
  constructor(
    private registry: ProviderRegistry,
    private credentialStorage: StorageAdapter,
    private routeStorage: PlatformRouteRepository,
    private callbackBaseUrl: string, // From LINK_CALLBACK_BASE
    private logger: Logger,
  ) {}

  /**
   * Initiate an app install flow.
   * Callback URL is server-derived, not user-provided.
   */
  async initiateInstall(
    providerId: string,
    redirectUri: string | undefined,
    userId: string,
  ): Promise<{ authorizationUrl: string }> {
    const provider = this.requireAppInstallProvider(providerId);
    const callbackUrl = `${this.callbackBaseUrl}/v1/app-install/callback`;

    const state = await encodeAppInstallState({
      p: providerId,
      r: redirectUri,
      u: userId,
    });

    this.logger.info("app_install_initiated", {
      provider: providerId,
      platform: provider.platform,
      userId,
    });

    return {
      authorizationUrl: provider.buildAuthorizationUrl(callbackUrl, state),
    };
  }

  /**
   * Complete an app install flow.
   * Handles idempotent re-install (updates existing credential).
   */
  async completeInstall(
    state: string,
    code: string,
  ): Promise<
    { credential: Credential; redirectUri?: string; updated: boolean }
  > {
    const decoded = await decodeAppInstallState(state);
    const { p: providerId, r: redirectUri, u: userId } = decoded;

    const provider = this.requireAppInstallProvider(providerId);
    const callbackUrl = `${this.callbackBaseUrl}/v1/app-install/callback`;

    const result = await provider.completeInstallation(code, callbackUrl);

    // Check for existing credential by externalId (re-install case)
    const existingCredential = await this.credentialStorage.findByProviderAndExternalId(
      result.credential.provider,
      result.externalId,
      userId ?? "dev",
    );

    let credentialId: string;
    let updated = false;

    if (existingCredential) {
      // Update existing credential instead of creating new
      await this.credentialStorage.update(
        existingCredential.id,
        result.credential,
        userId ?? "dev",
      );
      credentialId = existingCredential.id;
      updated = true;
    } else {
      const { id } = await this.credentialStorage.save(
        result.credential,
        userId ?? "dev",
      );
      credentialId = id;
    }

    // Upsert route (team_id → user_id only)
    await this.routeStorage.upsert(result.externalId, userId ?? "dev");

    const credential = await this.credentialStorage.get(
      credentialId,
      userId ?? "dev",
    );
    if (!credential) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        "Credential vanished after save",
      );
    }

    this.logger.info("app_install_completed", {
      provider: providerId,
      platform: provider.platform,
      externalId: result.externalId,
      externalName: result.externalName,
      credentialId,
      updated,
      userId,
    });

    return { credential, redirectUri, updated };
  }

  /**
   * Reconcile route for existing credential.
   * Idempotent recovery endpoint - re-creates route from credential data.
   */
  async reconcileRoute(
    providerId: string,
    credentialId: string,
    userId: string,
  ): Promise<void> {
    const provider = this.requireAppInstallProvider(providerId);
    const credential = await this.credentialStorage.get(credentialId, userId);

    if (!credential || credential.provider !== providerId) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        "Credential not found or mismatched provider",
      );
    }

    const secret = credential.secret as AppInstallCredentialSecret;
    if (!secret.externalId) {
      throw new AppInstallError(
        "INVALID_CREDENTIAL",
        "Credential missing external ID",
      );
    }

    // Upsert route (team_id → user_id only)
    await this.routeStorage.upsert(secret.externalId, userId);

    this.logger.info("app_install_route_reconciled", {
      provider: providerId,
      platform: provider.platform,
      externalId: secret.externalId,
      credentialId,
      userId,
    });
  }

  private requireAppInstallProvider(providerId: string): AppInstallProvider {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new AppInstallError(
        "PROVIDER_NOT_FOUND",
        `Provider not found: ${providerId}`,
      );
    }
    if (provider.type !== "app_install") {
      throw new AppInstallError(
        "INVALID_PROVIDER_TYPE",
        `Provider is not app_install type: ${providerId}`,
      );
    }
    return provider;
  }
}
```

### App Install State JWT

Separate from OAuth state (no PKCE verifier needed):

```typescript
// apps/link/src/app-install/app-state.ts

import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { STATE_JWT_SECRET } from "../oauth/jwt-secret.ts";

const AppInstallStateSchema = z.object({
  k: z.literal("app_install"), // Kind discriminator
  p: z.string(), // providerId
  r: z.string().optional(), // redirectUri (post-install)
  u: z.string().optional(), // userId
  exp: z.number(),
});

type AppInstallState = z.infer<typeof AppInstallStateSchema>;

export async function encodeAppInstallState(
  payload: Omit<AppInstallState, "k" | "exp">,
): Promise<string> {
  return await sign(
    { k: "app_install", ...payload, exp: Math.floor(Date.now() / 1000) + 600 },
    STATE_JWT_SECRET,
  );
}

export async function decodeAppInstallState(
  state: string,
): Promise<AppInstallState> {
  const payload = await verify(state, STATE_JWT_SECRET);
  return AppInstallStateSchema.parse(payload);
}
```

Shared JWT secret (factored out from oauth):

```typescript
// apps/link/src/oauth/jwt-secret.ts

import { readFileSync } from "node:fs";
import process from "node:process";

const secretFile = process.env.LINK_STATE_SIGNING_KEY_FILE;
export const STATE_JWT_SECRET = secretFile
  ? readFileSync(secretFile, "utf-8").trim()
  : crypto.randomUUID();
```

### Domain Error Type

```typescript
// apps/link/src/app-install/errors.ts

/**
 * App install service errors with machine-readable codes.
 */
export class AppInstallError extends Error {
  constructor(
    public readonly code: AppInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppInstallError";
  }
}

type AppInstallErrorCode =
  | "PROVIDER_NOT_FOUND" // Provider ID doesn't exist in registry
  | "INVALID_PROVIDER_TYPE" // Provider exists but isn't app_install type
  | "STATE_INVALID" // State JWT invalid or expired
  | "SLACK_NETWORK_ERROR" // Network failure (DNS, timeout, connection refused)
  | "SLACK_HTTP_ERROR" // Slack returned non-2xx
  | "SLACK_PARSE_ERROR" // Slack response wasn't valid JSON
  | "SLACK_OAUTH_ERROR" // Slack returned ok: false
  | "CREDENTIAL_NOT_FOUND" // Race condition in storage
  | "INVALID_CREDENTIAL"; // Credential missing expected fields
```

### Slack Provider Implementation

New file `providers/slack-app.ts`:

```typescript
import { readFileSync } from "node:fs";
import { env } from "node:process";
import { z } from "zod";
import { type AppInstallProvider, defineAppInstallProvider } from "./types.ts";
import { AppInstallError } from "../app-install/errors.ts";

const SlackOAuthSuccessSchema = z
  .object({
    ok: z.literal(true),
    access_token: z.string().startsWith("xoxb-"),
    token_type: z.literal("bot"),
    scope: z.string().default(""),
    bot_user_id: z.string(),
    app_id: z.string(),
    team: z.object({ id: z.string(), name: z.string() }),
    authed_user: z.object({ id: z.string() }).optional(),
    // Token rotation fields (optional)
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();

const SlackOAuthErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().optional(),
  })
  .passthrough();

const SlackOAuthResponseSchema = z.discriminatedUnion("ok", [
  SlackOAuthSuccessSchema,
  SlackOAuthErrorSchema,
]);

/** Required bot scopes for Atlas Slack integration */
const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "channels:read",
  "app_mentions:read",
] as const;

export function createSlackAppInstallProvider():
  | AppInstallProvider
  | undefined {
  const clientIdFile = env.SLACK_APP_CLIENT_ID_FILE;
  const clientSecretFile = env.SLACK_APP_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    return undefined;
  }

  const clientId = readFileSync(clientIdFile, "utf-8").trim();
  const clientSecret = readFileSync(clientSecretFile, "utf-8").trim();

  return defineAppInstallProvider({
    id: "slack-app",
    platform: "slack",
    displayName: "Slack",
    description: "Install Atlas bot into a Slack workspace",
    docsUrl: "https://api.slack.com/apps",

    buildAuthorizationUrl(callbackUrl, state) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeInstallation(code, callbackUrl) {
      let resp: Response;
      try {
        resp = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: new URLSearchParams({
            code,
            redirect_uri: callbackUrl,
          }),
        });
      } catch (err) {
        throw new AppInstallError(
          "SLACK_NETWORK_ERROR",
          `Network error calling Slack: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!resp.ok) {
        throw new AppInstallError(
          "SLACK_HTTP_ERROR",
          `Slack OAuth returned HTTP ${resp.status}`,
        );
      }

      const raw = await resp.json().catch(() => {
        throw new AppInstallError(
          "SLACK_PARSE_ERROR",
          "Invalid JSON from Slack",
        );
      });

      const parsed = SlackOAuthResponseSchema.parse(raw);
      if (!parsed.ok) {
        throw new AppInstallError(
          "SLACK_OAUTH_ERROR",
          parsed.error ?? "Unknown Slack OAuth error",
        );
      }

      const data = parsed;

      return {
        externalId: data.team.id,
        externalName: data.team.name,
        credential: {
          type: "oauth",
          provider: "slack-app",
          label: data.team.name,
          secret: {
            externalId: data.team.id, // Stored for reconcileRoute
            access_token: data.access_token,
            token_type: "bot",
            refresh_token: data.refresh_token,
            expires_at: data.expires_in
              ? Math.floor(Date.now() / 1000) + data.expires_in
              : undefined,
            slack: {
              botUserId: data.bot_user_id,
              appId: data.app_id,
              teamId: data.team.id,
              teamName: data.team.name,
              scopes: data.scope.split(",").map((s) => s.trim()).filter(
                Boolean,
              ),
            },
          },
        },
      };
    },

    async healthCheck(secret) {
      // secret is AppInstallCredentialSecret - access_token always present
      const resp = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret.access_token}` },
      });
      const data = await resp.json();
      return data.ok
        ? { healthy: true, metadata: { team: data.team } }
        : { healthy: false, error: data.error };
    },
  });
}
```

### Provider Naming

- `slack` — Existing API key provider (unchanged)
- `slack-app` — New app install provider

No renaming of existing provider. No breaking change.

## File Structure

```
apps/link/src/
├── providers/
│   ├── types.ts                        # Add AppInstallProvider type
│   ├── slack.ts                        # Existing API key provider (unchanged)
│   ├── slack-app.ts                    # New: Slack app install provider
│   └── registry.ts                     # Register slack-app provider
├── app-install/                        # Not "apps/" to avoid confusion
│   ├── service.ts                      # New: AppInstallService
│   ├── routes.ts                       # New: /v1/app-install routes
│   ├── app-state.ts                    # New: App install state JWT
│   └── errors.ts                       # New: AppInstallError
├── oauth/
│   ├── jwt-state.ts                    # Existing (unchanged)
│   └── jwt-secret.ts                   # New: factored out shared secret
├── adapters/
│   ├── storage.ts                      # Existing: add findByProviderAndExternalId
│   └── platform-route-repository.ts    # New: team_id → user_id upsert
└── index.ts                            # Mount /v1/app-install routes
```

## Configuration

```bash
# Paths to secret files (mounted from k8s secrets)
SLACK_APP_CLIENT_ID_FILE=/run/secrets/slack-app-client-id
SLACK_APP_CLIENT_SECRET_FILE=/run/secrets/slack-app-client-secret

# Existing
LINK_CALLBACK_BASE=https://link.example.com
```

Bot scopes are hardcoded: `chat:write`, `channels:history`, `channels:read`,
`app_mentions:read`. Add scopes by updating `SLACK_BOT_SCOPES` in code.

## Dependencies

**Prerequisites:** None. This implementation uses existing infrastructure:

- Existing `platform_route` table schema (`team_id`, `user_id`)
- Existing signal-gateway query (`SELECT user_id FROM platform_route WHERE team_id = $1`)
- Existing `StorageAdapter` for credential storage

No schema migrations. No signal-gateway changes.

## Flow Diagram

```
┌──────────┐     ┌──────┐     ┌───────┐     ┌──────────────┐
│  Client  │     │ Link │     │ Slack │     │   Storage    │
└────┬─────┘     └──┬───┘     └───┬───┘     └──────┬───────┘
     │              │             │                │
     │ GET /app-install/slack-app/authorize        │
     │──────────────>             │                │
     │              │             │                │
     │  302 → slack.com/oauth/v2/authorize         │
     │<──────────────             │                │
     │              │             │                │
     │  User authorizes + installs│                │
     │─────────────────────────────>               │
     │              │             │                │
     │  302 → link/app-install/callback?code=...   │
     │<─────────────────────────────               │
     │              │             │                │
     │ GET /app-install/callback?code=...&state=...│
     │──────────────>             │                │
     │              │             │                │
     │              │ POST oauth.v2.access         │
     │              │──────────────>               │
     │              │             │                │
     │              │ { access_token, team_id, ... }
     │              │<──────────────               │
     │              │             │                │
     │              │ Check existing credential    │
     │              │─────────────────────────────>│
     │              │             │                │
     │              │ Store/update credential      │
     │              │─────────────────────────────>│
     │              │             │                │
     │              │ UPSERT platform_route        │
     │              │ (team_id → user_id)          │
     │              │─────────────────────────────>│
     │              │             │                │
     │  302 → redirect_uri        │                │
     │<──────────────             │                │
```

Signal-gateway event routing continues to work unchanged - it queries
`platform_route` by `team_id` to get `user_id`, exactly as before.

## Future Work

- Discord bot install provider (`discord-app`)
- GitHub App install provider (`github-app`) — port from legacy auth service
- Uninstall/revoke flow
- Token rotation/refresh handling (fields already stored)
- Health check endpoint (`GET /v1/app-install/:provider/health/:credentialId`)
- **When Atlas needs outbound Slack API:** Add `credential_id` to platform_route
  and signal-gateway event payload so Atlas can fetch tokens without secondary
  lookup

## Design Decisions

| Decision                       | Rationale                                                 |
| ------------------------------ | --------------------------------------------------------- |
| Store as `type: "oauth"`       | Avoids DB migration. Provider ID is discriminator.        |
| No `credential_id` in route    | Not needed yet. Add when Atlas needs outbound Slack API.  |
| No schema migration            | Existing `team_id`/`user_id` columns work for routing.    |
| Re-install via credential query| Query by `externalId` in secret, not via route FK.        |
| Server-derived callback URL    | Security - callback URL not user-controllable.            |
| Separate state JWT             | OAuth state has PKCE; app installs don't need it.         |
| Idempotent re-install          | Matches Slack semantics, prevents stale tokens.           |
| No `slack` rename              | Avoid breaking existing credentials.                      |
| `app-install/` not `apps/`     | Clearer naming in `apps/link/src/`.                       |
| `externalId` in secret         | Enables re-install detection without route coupling.      |
| Hardcoded bot scopes           | YAGNI. Code change is fine when scope needs change.       |
| File-only secrets              | Single path for secrets. No env var code smell.           |

## Changelog

**v4 (2025-12-16):**

- **Major simplification:** Removed schema migration and signal-gateway changes
- Route table uses existing `team_id`/`user_id` columns (no `credential_id`)
- Re-install detection via `StorageAdapter.findByProviderAndExternalId()` instead
  of route lookup
- Simplified `PlatformRouteRepository` to just `findByTeamId`/`upsert`
- Deferred `credential_id` coupling to future work (when Atlas needs outbound API)
- Removed Event Flow diagram (signal-gateway unchanged)

**v3 (2025-12-16):**

- Removed env var fallback for secrets (file-based only)
- Hardcoded bot scopes (non-configurable, code change to modify)
- Fixed type inconsistency: `healthCheck` and
  `AppInstallResult.credential.secret` now use `AppInstallCredentialSecret`
- Removed unused `SlackCredentialSecretSchema` (healthCheck uses base type
  directly)
- Added comment explaining `externalId`/`slack.teamId` duplication

**v2 (2025-12-16):**

- Incorporated feedback from Amp, Codex, Gemini reviews
- Added `credential_id` to platform_route and signal-gateway event payload
- Changed to store credentials as `type: "oauth"` (no schema migration)
- Made callback URL server-derived (security)
- Added separate app-install state JWT module
- Added idempotent re-install behavior
- Added `AppInstallError` domain error type
- Added reconcile endpoint for failure recovery
- Added token rotation fields to credential schema
- Changed to HTTP Basic auth for Slack token exchange
- Kept `slack` provider name unchanged (no breaking change)
- Renamed directory from `apps/` to `app-install/`
- Added structured logging
- Added `externalId` to credential secret (platform-agnostic reconcile)
