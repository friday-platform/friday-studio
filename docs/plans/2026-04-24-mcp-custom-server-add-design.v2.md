<!-- v2 - 2026-04-24 - Generated via /improving-plans from docs/plans/2026-04-24-mcp-custom-server-add-design.md -->

# MCP Custom Server Addition

## Problem Statement

As a Friday user, I want to add an MCP server that does not exist in the official registry (or whose registry entry cannot be auto-installed due to unsupported transport). Today, the only paths are: (a) copy-paste a JSON blob into an API client and POST to the raw CRUD endpoint, or (b) add it to workspace.yml. Neither creates a Link provider, so credential management is manual env-var wrangling. The registry import flow (`/install`) auto-creates Link providers and makes `connect_service` the universal credential path — but it only works for servers discoverable on `registry.modelcontextprotocol.io`.

Users frequently find MCP servers on GitHub or in Claude Desktop configs with a simple `{command, args, env}` block, or with a bare HTTP endpoint URL. They should be able to paste either into the playground, preview what Friday will create, and have it go through the same install flow as a registry server: stored metadata + Link provider + `connect_service` support.

## Solution

Add a second tab to the existing "Add" modal in the MCP catalog page. Tab 1 is the existing command-palette registry search. Tab 2 is a simple "Add Custom" form with:

- **Name** and **Description** fields
- **HTTP Endpoint** input — a single URL. For servers like Linear that only need a streamable-http endpoint (OAuth discovery handles auth).
- **Configuration JSON** textarea — paste `{command, args, env}` or `{url, env}`. The parser is straightforward: `command` means stdio, `url` means http. `env` keys become required config and an API-key Link provider.

The two inputs are mutually exclusive — the user picks one. The backend stores the metadata, auto-creates the appropriate Link provider, and the server appears in the catalog immediately.

## User Stories

1. As a Friday user, I want to add a custom MCP server by pasting a simple JSON config, so that I can use servers that don't exist in the upstream registry.
2. As a Friday user, I want to add a streamable-http MCP server by just pasting its URL, so that I don't have to write JSON for servers that only need an endpoint.
3. As a Friday user, I want the JSON parser to accept `{command, args, env}` for stdio servers and `{url, env}` for http servers, so that I can paste configs from Claude Desktop or GitHub READMEs without reformatting.
4. As a Friday user, when I paste JSON with `headers` or other unsupported fields, I want clear instructions on how to reformat it (e.g. "use `env` for credentials"), so that I know what to fix rather than seeing a cryptic error.
5. As a Friday user, I want all `env` keys from the pasted JSON to become required credentials via Link, so that `connect_service` prompts me for each one.
6. As a Friday user, I want the pasted placeholder values (e.g. `"your_client_id"`) to be ignored as real credentials but shown as examples, so that I understand what each field expects.
7. As a Friday user, I want the submitted custom server to appear in the MCP catalog alongside built-in and registry-imported servers, so that I have a single inventory view.
8. As a Friday user, I want custom servers to use the same `connect_service` credential flow as registry-imported servers, so that I don't manage env vars manually.
9. As a Friday user, I want the custom server to be deletable from the catalog detail pane, so that I can remove experiments or broken entries.
10. As a Friday user, I want "Check for updates" on a custom server to gracefully tell me there is no upstream registry to check, so that I understand why the button is disabled or returns "no updates available."
11. As a Friday developer, I want the backend to have two clear paths — HTTP URL (OAuth provider) and JSON config (API-key provider from env) — so that there is no clever auto-detection or normalization magic.
12. As a Friday developer, I want custom servers to carry `source: "web"` in the stored metadata, so that the catalog UI groups them under "Other" and `check-update` / `pull-update` routes can detect the absence of `upstream` provenance.
13. As a Friday developer, I want the Link provider auto-creation failure to be non-blocking (store the entry, return a warning), so that a transient Link service outage doesn't prevent server registration.
14. As a Friday user, I want the server ID to be generated automatically from the name I type, with an option to edit it, so that I don't have to think about kebab-case slug formats.
15. As a Friday user, I want custom stdio servers to work immediately without triggering package-resolution false positives in workspace lint, so that my workspace config validation doesn't reject a server I just added.

## Implementation Decisions

### Modules affected

- **Playground UI** — `MCPRegistryImport.svelte` gains a tab bar ("Search Registry" / "Add Custom"). The "Add Custom" tab contains a simple form: name, description, auto-generated ID (editable), and two mutually exclusive inputs (HTTP URL or JSON textarea). `mcp-queries.ts` and `mcp.ts` gain a new `useAddCustomMCPServer` mutation hook. `+page.svelte` wires the new mutation to the modal.
- **Daemon MCP registry routes** — `apps/atlasd/routes/mcp-registry.ts` gains `POST /api/mcp-registry/custom`. Two distinct code paths: URL-only → OAuth provider; JSON with env → API-key provider.
- **Storage adapter** — no changes; `adapter.add()` already accepts `source: "web"` entries.

### Architectural decisions

- **Two mutually exclusive inputs, no transport selector.** The user fills either the HTTP URL field or the JSON textarea. Client-side validation ensures exactly one is provided. No dropdown, no auto-detection.
- **HTTP URL path.** Single URL input. Stored as `transport: { type: "http", url }`. Auto-creates a `DynamicOAuthProviderInput` with `mode: "discovery"` and `serverUrl` set to the provided URL. No `env`, no `requiredConfig`. The user connects via `connect_service` which triggers OAuth discovery against that URL. The UI must show clear copy under the URL field: "For endpoints that support OAuth discovery. For API-key authentication, use the JSON configuration tab."
- **JSON path.** Textarea accepts a single server config object. Supported shapes:
  - Stdio: `{ "command": "...", "args": [...], "env": {...} }`
  - HTTP with env: `{ "url": "...", "env": {...} }`
  - Claude Desktop wrapper: `{ "mcpServers": { "name": { ... } } }` (one server only; multiple → error with names listed)

  Rejected with instructions:
  - `headers` — error: "Use `env` for credentials instead of `headers`. Example: `\{\"url\":\"...\",\"env\":\{\"AUTHORIZATION\":\"Bearer YOUR_TOKEN\"\}\}""
  - `sse` transport — error: "SSE is not supported. Use `url` with streamable-http or `command` with stdio."
  - Missing both `command` and `url` — error: "Config must include either `command` (stdio) or `url` (http)."
  - Multiple servers in wrapper — error: "Paste one server at a time. Found: a, b."

- **Env vars conditionally produce a Link provider.** Every key in `env` becomes:
  - `requiredConfig: [{ key, description, type: "string", examples: [value] }]`
  - `configTemplate.env: { key: { from: "link", provider: id, key } }`
  - `DynamicApiKeyProviderInput.secretSchema: { key: "string" }`
  - When `env` is empty, no Link provider is created, `requiredConfig` is omitted, and `isConfigured()` returns `true` — the server is immediately usable.
  - This matches the existing registry import behavior (npm+stdio without env vars → no provider).

- **Env var description synthesis.** Pasted JSON (Claude Desktop, GitHub READMEs) does not include descriptions for env keys. The parser synthesizes a fallback description: `` `${key} (e.g. ${value})` ``. If the value is empty, the fallback is `` `Credential: ${key}` ``. This avoids every requiredConfig field showing the useless description `"key"`.

- **Values from pasted JSON are used as examples only.** Whatever string appears as the value in the `env` object is included in `requiredConfig.examples` and shown in the UI as an example. It is never stored as an actual credential. The real credential is provided later via `connect_service` and stored in Link.

- **No `upstream` provenance.** Custom servers lack `upstream`, so existing `check-update` and `pull-update` routes already handle this gracefully. No route changes needed.

- **Blessed and duplicate collision checks identical to existing routes.** 409 if ID collides with static blessed entry. 409 if `adapter.get(id)` already exists.

- **`source: "web"` stamped on stored entry.** Grouped under "Other" in the catalog tree alongside any existing `"web"` entries. No new source enum value; the "Other" grouping is sufficient.

- **No README fetch.** Custom servers have no repository URL. `readme` omitted.

- **Security rating always `"unverified"`.**

- **Server ID auto-generated from name, editable.** The client form generates a kebab-case ID from the typed name (lowercase, non-alphanumeric → dashes, truncate at 64). The user sees it in a secondary field and can override. The server-side schema accepts `id` as optional and auto-generates it if omitted, using the same rules.

- **Custom stdio entries set `skipResolverCheck: true`.** Custom servers are not blessed and may use private binaries, uvx packages not yet on PyPI, or local commands. The config validator's package-resolution pass would falsely reject these. Every custom stdio entry carries `skipResolverCheck: true` in its `configTemplate`.
- **No-env stdio servers are immediately usable.** When a pasted JSON config has `command`/`args` but no `env`, no Link provider is created, `requiredConfig` is omitted, and `isConfigured()` returns `true`. The server appears as fully configured in `list_mcp_servers` and requires no `connect_service` call. This is consistent with registry-imported npm+stdio servers that have no upstream `environmentVariables`.

### Schema changes

No additive schema changes. Reuses existing `MCPServerMetadataSchema`, `MCPSourceSchema` (`"web"` already exists), `DynamicApiKeyProviderInput`, and `DynamicOAuthProviderInput`.

**Request schema (`POST /api/mcp-registry/custom`):**

```ts
const AddCustomServerRequestSchema = z.object({
  name: z.string().min(1).max(100),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64)
    .optional(),
  description: z.string().max(500).optional(),
  // Exactly one of these must be present
  httpUrl: z.string().url().optional(),
  configJson: z.object({
    transport: z.union([
      z.object({
        type: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
      z.object({
        type: z.literal("http"),
        url: z.string().url(),
      }),
    ]),
    envVars: z.array(
      z.object({
        key: z.string().min(1).max(128),
        description: z.string().max(200).optional(),
        exampleValue: z.string().optional(),
      })
    ).default([]),
  }).optional(),
}).refine(
  (data) => (data.httpUrl ? !data.configJson : !!data.configJson),
  { message: "Provide either httpUrl or configJson, not both." }
);
```

**ID generation (server-side fallback):**

```ts
function deriveId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
```

If `id` is omitted from the request, the route calls `deriveId(name)`. If the derived ID collides with an existing entry, the route appends a 4-character timestamp suffix (`-${Date.now().toString(36).slice(-4)}`) and retries once. If still colliding, returns 409.

**Response:** 201 `{ server: MCPServerMetadata }` or 201 `{ server: MCPServerMetadata, warning: string }` if Link provider creation failed.

### API contracts

- **`POST /api/mcp-registry/custom`** — body `AddCustomServerRequestSchema`. Validates, derives/generates ID, checks collisions, builds `MCPServerMetadata`, persists via `adapter.add()`, auto-creates Link provider. Returns 201 with stored entry. 400 on schema validation or mutually-exclusive check fail. 409 on blessed or dynamic ID collision. 502 on Link provider creation network failure (still stores entry, includes `warning`).

### Module Boundaries

**Client-side form (`MCPRegistryImport` "Add Custom" tab)**
- *Interface:* Form state → `AddCustomServerRequestSchema` payload on submit. Fields: `name`, `description`, `id` (auto-generated, editable), and two mutually exclusive inputs: `httpUrl` (string) or raw JSON textarea (string → parsed object → `configJson`).
- *Hides:* the JSON parsing rules; placeholder detection; ID derivation from name; the mutually-exclusive validation logic.
- *Trust contract:* on submit, the payload validates against the daemon schema. If JSON parsing fails, the error is rendered inline next to the textarea. If both inputs are filled, client-side validation blocks submit. The `id` field is pre-filled from `name` via `deriveId` and the user may override.

**Client-side JSON parser (inline helper)**
- *Interface:* `(rawJson: string) => { transport, envVars, suggestedName? } | ParseError`
- *Hides:* the three accepted shapes (bare stdio, bare http, Claude Desktop wrapper); `mcpServers` key extraction for suggested name; `headers` rejection with example message; multiple-server detection; description synthesis from key+value.
- *Trust contract:* on success, the returned shape is validatable against the `configJson` sub-schema. On error, the message is safe to render inline and includes a concrete example of correct formatting.

**`POST /api/mcp-registry/custom` route handler**
- *Interface:* `AddCustomServerRequestSchema` in, `MCPServerMetadata` (+ optional `warning`) out.
- *Hides:* ID derivation when omitted; the two provider-creation paths (OAuth for URL, API-key for JSON env); the collision checks (blessed + dynamic); `skipResolverCheck` stamping for stdio; the `adapter.add()` + best-effort Link POST sequence.
- *Trust contract:* on 201, the entry is persisted and immediately visible via `GET /`. HTTP-URL entries have `transport.type: "http"` and an OAuth provider. JSON entries have `transport` from the parsed config and an API-key provider if `envVars` is non-empty. Every custom stdio entry has `skipResolverCheck: true`. On 409, no state change. On 201 with `warning`, the entry is persisted but the Link provider may not exist.

**`useAddCustomMCPServer` mutation hook**
- *Interface:* `mutateAsync(AddCustomServerRequestSchema payload)` → `InstallResponseSchema`.
- *Hides:* the daemon client call; `queryClient.invalidateQueries` on success; error parsing into `Error` with message.
- *Trust contract:* on success, the catalog query is invalidated so the new server appears immediately. On error, throws an `Error` with a user-readable message suitable for toast display.

### Data Isolation

Not applicable. The MCP registry is a single-tenant daemon resource.

## Testing Decisions

**Daemon route integration tests** (extend `apps/atlasd/routes/mcp-registry.test.ts`):
- HTTP URL happy path → 201, `source: "web"`, `transport.type: "http"`, OAuth provider creation called.
- JSON stdio with env → 201, `transport.type: "stdio"`, `skipResolverCheck: true`, `configTemplate.env` has Link refs, API-key provider creation called.
- JSON http with env → 201, `transport.type: "http"`, API-key provider creation called.
- JSON no env → 201, no `requiredConfig`, no provider creation.
- Validation fail: both `httpUrl` and `configJson` → 400.
- Validation fail: neither provided → 400.
- Blessed collision → 409.
- Duplicate dynamic ID → 409.
- Link provider creation failure → 201 with `warning`, entry still persisted.
- Omitting `id` in request → server derives from `name` and succeeds.
- Omitting `id` with collision → server appends timestamp suffix and succeeds.

**Client-side JSON parser tests** (new file in `packages/core/src/mcp-registry/`, e.g. `custom-parser.test.ts`):
- Bare `{command, args, env}` parses to stdio transport + env vars with synthesized descriptions and values used as examples.
- Bare `{url, env}` parses to http transport + env vars with synthesized descriptions.
- Claude Desktop wrapper with one server parses, extracts name from `mcpServers` key.
- Multiple servers in wrapper → error with named keys.
- `headers` field present → error with example of `env` format.
- Missing both `command` and `url` → error.
- Malformed JSON → "Invalid JSON" error.
- Empty `env` → empty `envVars` array.
- Real-looking credential values in `env` are included as examples in `requiredConfig` (not stored as credentials).
- Description synthesis: key + value → `` `${key} (e.g. ${value})` ``; empty value → `Credential: ${key}`.

**Playground route integration test** (extend existing):
- `POST /tools` resolves a custom-added server ID when the adapter contains the entry.

**Manual smoke test:**
- Paste `https://mcp.linear.app/mcp` as HTTP URL, submit, verify OAuth provider created and catalog entry visible.
- Paste `{command: "uvx", args: ["spotify-mcp"], env: {SPOTIFY_CLIENT_ID: "your_id"}}` as JSON, submit, verify API-key provider created with `SPOTIFY_CLIENT_ID` field.
- Verify workspace lint does not reject the custom stdio server (confirm `skipResolverCheck: true` is present).

## Out of Scope

- **Headers normalization.** The parser rejects `headers` and shows instructions. Users must reformat to `env`.
- **SSE or WebSocket transport.** Only `stdio` and `http` are supported. Rejected with clear message.
- **Editing a custom server after creation.** Delete and re-add.
- **Importing multiple servers at once.** One submit, one server.
- **Fetching README or repository metadata.** No GitHub API calls, no README content.
- **Workspace-configured server promotion.** Stored in MCP registry adapter, not workspace.yml.
- **Security rating override.** Always `"unverified"`.
- **URL domain auto-detection for LLM routing.** Custom servers do not populate `urlDomains`.
- **Per-field form for command/args/env.** JSON textarea only for structured configs.
- **Auth-type toggle on the URL tab.** The URL tab is OAuth-only by design. API-key HTTP servers use the JSON tab.
- **Custom `source` enum value.** Reuses `"web"`; grouped under "Other" with raw CRUD entries.

## Further Notes

The `"web"` source value predates this feature and was used for manually-authored entries POSTed to the raw CRUD endpoint. Custom paste entries share this source. The catalog tree already groups non-static, non-registry entries under "Other", so custom servers appear there without UI changes.

The `MCPRegistryImport` modal name is now slightly misleading. A rename to `MCPAddServerModal` or similar is reasonable follow-up cleanup but out of scope for this plan.

The `skipResolverCheck: true` flag on custom stdio entries prevents a class of false-positive validation errors. The config validator's package-resolution pass is designed to catch LLM-hallucinated package names in workspace configs. Custom servers added by explicit user paste should not be subject to this heuristic.

The `z.union` choice for `transport` in `configJson` follows the project's Zod v4 conventions. `z.discriminatedUnion` is avoided due to known issues with duplicate discriminator values and deep TypeScript instantiation errors in this codebase.
