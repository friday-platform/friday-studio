# Link

Credential management and OAuth orchestration for Atlas.

Link stores API keys and OAuth tokens, manages token refresh, and provides a
unified interface for agents to access external services.

## What Link Does

1. **Stores credentials** — API keys and OAuth tokens persisted in Deno KV,
   scoped by user
2. **Orchestrates OAuth flows** — Handles authorization, token exchange, PKCE,
   and dynamic client registration
3. **Manages token lifecycle** — Proactively refreshes expiring tokens before
   agents need them
4. **Catalogs providers** — Registry of supported services with schemas,
   instructions, and health checks

## Quick Start

```bash
# Run the service
deno task start

# Run tests
deno task test
```

Environment variables:

| Variable                     | Description                              | Default                   |
| ---------------------------- | ---------------------------------------- | ------------------------- |
| `LINK_PORT`                  | HTTP server port                         | `3100`                    |
| `LINK_DB_PATH`               | Deno KV database path                    | `~/.atlas/credentials.db` |
| `LINK_DEV_MODE`              | Skip JWT verification                    | `false`                   |
| `LINK_JWT_PUBLIC_KEY_FILE`   | Path to RS256 public key (prod mode)     | Required if not dev mode  |
| `LINK_STATE_SIGNING_KEY_FILE`| Secret for signing OAuth state JWTs      | Random UUID (ephemeral)   |
| `LINK_CALLBACK_BASE`         | Base URL for OAuth callbacks             | Request origin            |
| `LINK_ALLOW_INSECURE_HTTP`   | Allow HTTP OAuth callbacks (dev only)    | `false`                   |

### GitHub App Provider

The GitHub App provider allows users to install a GitHub App for organization-level access. All five environment variables are required for the provider to activate.

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID_FILE` | Path to file containing the GitHub App's numeric App ID (used for JWT signing) |
| `GITHUB_APP_CLIENT_ID_FILE` | Path to file containing the GitHub App's OAuth client ID (used for OAuth code exchange) |
| `GITHUB_APP_CLIENT_SECRET_FILE` | Path to file containing the GitHub App's OAuth client secret |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to file containing the GitHub App's RSA private key (PKCS#1 format from GitHub) |
| `GITHUB_APP_INSTALLATION_URL` | Full URL to your GitHub App installation page (e.g., `https://github.com/apps/your-app/installations/new`) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Routes                              │
├─────────────────────────────────────────────────────────────┤
│  /v1/providers      Provider catalog (list, get details)    │
│  /v1/credentials    Credential CRUD (create, list, delete)  │
│  /v1/oauth          OAuth flows (authorize, callback)       │
│  /internal/v1/*     Runtime access with token refresh       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────┐
│                      Core Services                          │
├─────────────────────────────────────────────────────────────┤
│  OAuthService       Flow orchestration, token refresh       │
│  ProviderRegistry   Provider definitions and lookup         │
│  StorageAdapter     Credential persistence (Deno KV)        │
└─────────────────────────────────────────────────────────────┘
```

### Request Flow

Every request includes a user ID via the `X-Atlas-User-ID` header. In
production, JWT verification ensures requests are authenticated. All credential
operations are scoped to this user.

### Multi-Tenancy

Credentials are stored with composite keys: `["credentials", userId, credentialId]`.
Users can only access their own credentials.

## API Reference

### Providers

```bash
# List all providers
GET /v1/providers

# Get provider details (schema, setup instructions)
GET /v1/providers/:id
```

### Credentials

```bash
# Create credential (validates against provider schema)
PUT /v1/credentials/:type
Content-Type: application/json
{
  "provider": "slack",
  "label": "My Bot Token",
  "secret": { "token": "xoxb-..." }
}

# List credentials by type
GET /v1/credentials/type/:type

# Get credential metadata (no secret)
GET /v1/credentials/:id

# Delete credential
DELETE /v1/credentials/:id
```

### OAuth

```bash
# Start OAuth flow
GET /v1/oauth/authorize/:provider?redirect_uri=https://myapp.com/callback

# OAuth callback (handles token exchange)
GET /v1/oauth/callback?code=...&state=...

# Manual token refresh
POST /v1/oauth/credentials/:id/refresh
```

### Internal (Runtime Access)

```bash
# Get credential with secret and proactive refresh
GET /internal/v1/credentials/:id

# Response includes status:
# - "ready": token is fresh
# - "refreshed": token was just refreshed
# - "expired_no_refresh": no refresh token available
# - "refresh_failed": refresh attempted but failed
```

## Providers

Providers define how credentials are validated and stored.

### API Key Providers

Define a Zod schema for validation and optionally a health check:

```typescript
const slackProvider = defineApiKeyProvider({
  id: "slack",
  displayName: "Slack",
  description: "Slack Bot or User Token",
  setupInstructions: "# Get a Slack token\n1. Go to api.slack.com...",
  secretSchema: z.object({
    token: z.string().regex(/^xox[bp]-/, "Must be bot or user token"),
  }),
  health: async (secret) => {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${secret.token}` },
    });
    const data = await res.json();
    return data.ok
      ? { healthy: true, metadata: { team: data.team } }
      : { healthy: false, error: data.error };
  },
});
```

### OAuth Providers

Two modes: **discovery** (MCP servers) and **static** (traditional OAuth).

```typescript
// Discovery mode - uses RFC 9728 Protected Resource Metadata
const mcpProvider = defineOAuthProvider({
  id: "my-mcp-server",
  displayName: "My MCP Server",
  oauth: {
    mode: "discovery",
    protectedResourceUrl: "https://mcp.example.com",
    defaultScopes: ["read", "write"],
  },
  identify: async (tokens) => ({
    identifier: tokens.id_token_claims?.sub ?? "unknown",
  }),
});

// Static mode - pre-configured endpoints
const googleProvider = defineOAuthProvider({
  id: "google",
  displayName: "Google",
  oauth: {
    mode: "static",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    defaultScopes: ["openid", "email"],
  },
  identify: async (tokens, authServer) => {
    const userinfo = await fetchUserinfo(tokens, authServer);
    return { identifier: userinfo.email, label: userinfo.name };
  },
});
```

## OAuth Flow

Link uses stateless JWT-encoded flow state. No server-side session storage.

```
1. User clicks "Connect Slack"
       │
       ▼
2. GET /v1/oauth/authorize/slack?redirect_uri=...
   - Generate PKCE code verifier/challenge
   - Encode flow state as signed JWT (10-min expiry)
   - Redirect to Slack authorization URL
       │
       ▼
3. User authorizes on Slack
       │
       ▼
4. GET /v1/oauth/callback?code=...&state=...
   - Decode JWT state
   - Exchange code for tokens (PKCE)
   - Call provider.identify() to get user identifier
   - Create credential: oauth:slack:U12345678
   - Redirect to original redirect_uri
```

### Credential Identity

OAuth credentials use synthetic IDs: `oauth:{provider}:{userIdentifier}`.
Re-authorizing the same account upserts the existing credential. Different
accounts create new credentials.

### Token Refresh

The internal endpoint proactively refreshes tokens expiring within 5 minutes.
Agents get working tokens without handling 401s or refresh logic.

## Project Structure

```
src/
├── index.ts              App bootstrap, middleware composition
├── factory.ts            Typed Hono factory
├── types.ts              Core domain types (Credential, Provider)
├── routes/
│   ├── credentials.ts    CRUD endpoints
│   ├── oauth.ts          OAuth flow endpoints
│   └── providers.ts      Provider catalog
├── oauth/
│   ├── service.ts        OAuth orchestration
│   ├── jwt-state.ts      Stateless flow state encoding
│   ├── discovery.ts      RFC 9728/8414 metadata discovery
│   ├── static.ts         Static endpoint configuration
│   ├── tokens.ts         Token exchange and refresh
│   ├── registration.ts   Dynamic client registration
│   └── client.ts         oauth4webapi wrapper
├── providers/
│   ├── registry.ts       Provider registry
│   ├── types.ts          Provider type definitions
│   └── *.ts              Built-in providers (slack, google, notion)
└── adapters/
    └── deno-kv-adapter.ts  Deno KV storage implementation
```

## Key Patterns

**Discriminated unions** — Provider types, OAuth config modes, and response
statuses use Zod discriminated unions for exhaustive type checking.

**Stateless OAuth** — Flow state encoded as signed JWT eliminates server-side
storage. Survives horizontal scaling and restarts.

**Proactive refresh** — Internal endpoint refreshes tokens before expiry.
Agents don't handle token lifecycle.

**Provider registry** — Compile-time type safety via Zod inference. Runtime
validation against provider schemas.

**Adapter pattern** — Storage abstraction allows pluggable backends. Currently
Deno KV; production could use Vault, AWS Secrets Manager, etc.

## Development

```bash
# Type check
deno check src/**/*.ts

# Lint
deno lint

# Test
deno task test

# Test specific file
deno task test tests/oauth.test.ts
```

Dev mode (`LINK_DEV_MODE=true`) skips JWT verification and defaults the user ID
to "dev".
