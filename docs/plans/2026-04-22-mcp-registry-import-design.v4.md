<!-- v4 - 2026-04-22 - Generated via /improving-plans from docs/plans/2026-04-22-mcp-registry-import-design.v3.md -->

# MCP Registry Import

## Problem Statement

As a Friday user, I want to discover and install MCP servers from the official Model Context Protocol registry the same way I install skills from skills.sh — type a query, pick a result, one-click install. Today my only paths are (a) the ~19 hand-curated blessed servers in the consolidated registry, which I can't add to without a PR, or (b) manually authoring an `MCPServerMetadata` JSON blob and POSTing it to the existing endpoint. Neither scales to the hundreds of community MCP servers published upstream.

## Solution

Add search + install + update flows against `registry.modelcontextprotocol.io`. The playground gets a new `/mcp` catalog page that renders the merged list of static (blessed) + dynamic (registry-imported) servers, with a "Browse registry" modal for discovery inline on the same page. The daemon gets four new routes alongside the existing MCP registry CRUD: a search proxy, an install-by-canonical-name endpoint, and check-for-updates / pull-update endpoints that mirror the skills-sh flow. Registry-imported entries carry a small `upstream` provenance blob so the update flow can re-fetch and re-translate atomically.

## User Stories

1. As a Friday user, I want to search the official MCP registry from the playground by typing a keyword, so that I can discover servers I didn't know existed.
2. As a Friday user, I want search results to appear as I type (debounced), so that I can find the right server without committing to a full query.
3. As a Friday user, I want to see which search results are already installed, so that I don't waste effort trying to re-install them.
4. As a Friday user, I want to click a search result and have the server installed in one step, so that I don't have to hand-author configuration.
5. As a Friday user, I want an installed server to work immediately for npm+stdio servers, so that the only thing left is providing credentials when the workspace runs it.
6. As a Friday user, I want an installed server to work immediately for hosted HTTP servers, so that I can connect to streamable-http endpoints without transport plumbing.
7. As a Friday user, I want a clear error when a server can't be auto-installed (docker-only, sse-only, pypi-only, no packages and no remotes, or remotes with unresolved URL variables), so that I understand why and can open the repo to investigate.
8. As a Friday user, I want the catalog page to show built-in servers and installed-from-registry servers side by side, so that I can see my full MCP inventory in one place.
9. As a Friday user, I want each catalog entry labeled with its provenance (built-in vs registry vs manual), so that I know which entries I can update and which are maintained by the Friday team.
10. As a Friday user, I want a "check for updates" action on registry-imported entries, so that I can tell when the upstream has published a new version.
11. As a Friday user, I want a "pull update" action on registry-imported entries, so that I can refresh an installed server to the latest upstream version without deleting and re-installing.
12. As a Friday user, I want pulling an update to preserve the kebab-case ID of the stored entry, so that any workspace references to the server survive the update.
13. As a Friday user, I want attempts to install a server whose translated ID collides with a blessed static entry to fail with a clear message, so that I can't silently overwrite a curated server.
14. As a Friday user, I want attempts to install an already-imported server to fail with a clear message, so that I understand the duplicate rather than seeing silent success.
15. As a Friday user, I want installed registry servers to carry the required-env-vars contract from the upstream, so that the playground's connect flow can prompt me for exactly what the server needs.
16. As a Friday user, I want the import modal to hint at the upstream registry URL, so that I can browse the full catalog on modelcontextprotocol.io if I want more context.
17. As a Friday engineer, I want registry-imported entries to carry an `upstream` provenance blob, so that future features (reflection, auto-update scheduling) can identify which entries originated upstream.
18. As a Friday engineer, I want transport translation to be a pure function, so that I can add new translation rules or registries without touching the route or HTTP client.
19. As a Friday engineer, I want route tests to exercise the wiring (translator → adapter → status code), so that I catch integration regressions that unit tests on the translator alone would miss.
20. As a Friday engineer, I want to continue using the existing `MCPServerMetadata` schema, so that the rest of the system (workspace execution, LLM tool routing, blessed registry) consumes registry-imported entries without changes.

## Implementation Decisions

### Modules affected

- **Core registry package** — a new Zod-validated HTTP client for the upstream registry, a new pure translator function, and one additive optional field on the existing server metadata schema plus a new enum value on the `source` field.
- **Daemon MCP registry routes** — four new routes (search proxy, install, check-update, pull-update) added to the existing router; existing CRUD routes untouched. The daemon's `GET /` becomes the single source of truth for the merged server list.
- **Storage adapter interface** — one new method (`update`) added to the adapter interface and both implementations (local KV + cortex).
- **Playground UI** — one new catalog page at `/mcp`. The import modal is inline in that page, not a separate component. All listing/search/install/update queries go through the daemon routes via the playground's `/api/daemon/...` proxy. The playground's existing `GET /servers` route is removed; `POST /tools` stays in the playground since it requires in-process MCP client connections, but it is modified to merge dynamic entries from the storage adapter per-request so that registry-imported servers are resolvable at tool-connect time.
- **Playground query hooks** — TanStack wrappers for the four new daemon routes plus a list-all wrapper over the existing daemon `GET /`.
- **Playground shared sidebar** — one new `NavItem` added to the `toolLinks` array pointing to `/mcp`.
- **Daemon client factory** (`tools/agent-playground/src/lib/daemon-client.ts`) — add a new `mcp` entry to `makeDaemonClient` mapping the `MCPRegistryRoutes` type to `/api/daemon/api/mcp-registry`.

### Architectural decisions

- **Single upstream source.** Only `registry.modelcontextprotocol.io` is supported. The provenance blob records this implicitly by being present; no discriminator field until a second source exists.
- **Translator is the single mapping point.** Every schema decision (package selection, transport mapping, kebab-ID derivation, env placeholder defaulting, `source`/`securityRating` stamping) lives in one pure function. Route and HTTP client stay schema-agnostic.
- **Install fetches `versions/latest` explicitly.** The upstream search endpoint can return multiple versions of the same canonical name (e.g., `io.github/Digital-Defiance/mcp-filesystem` appears at versions `0.1.0` and `0.1.9` simultaneously). The install route calls `fetchLatest(registryName)` to get the authoritative latest before translating. Search results are raw proxy — no translation or version selection happens on the search path.
- **Transport precedence — errs toward npx stdio.** Rule 1 picks the first `packages[]` entry with `registryType === "npm"` and `transport.type === "stdio"`, emitting `npx -y <identifier>@<server.version>`. Rule 2 picks the first `remotes[]` entry with `type === "streamable-http"` whose URL contains no unresolved template variables (see below), emitting our `http` transport. Everything else rejects with a user-readable reason.
- **URL variable handling in remotes.** Upstream `remotes[].url` can contain template variables like `{tenant_id}` or `{env}`. The translator substitutes variables that have `default` values. If any required variable lacks a default, the remote is rejected: *"This server requires configuration that can't be auto-filled (e.g., tenant_id: Microsoft Entra tenant ID). Configure it manually or install from the repo."* Future v2 can add URL templating to `configTemplate.transport` and map these variables to `requiredConfig`.
- **No server-side TTL cache on the upstream client.** TanStack Query's `staleTime` on the playground handles cache staleness. Search debounce is handled client-side via `setTimeout` (same pattern as `skills-sh-import.svelte`), not via `staleTime`. A server-side cache would add complexity without serving additional consumers in a local-only dev tool.
- **Detail fetches are always fresh.** Install, check-update, and pull-update all bypass cache. Stale provenance would produce wrong answers on the update flow; freshness matters more than latency.
- **ID-collision guard stays server-side.** The existing 409 on blessed collision is the authoritative guard. The search response carries `alreadyInstalled: boolean` per result as an early UI hint; the flag is computed server-side by cross-referencing upstream canonical names against the local adapter's stored entries.
- **Pull-update preserves the stored kebab ID.** Re-translation would produce the same ID in practice today, but we preserve the existing ID explicitly so that any future change to kebab derivation rules doesn't silently break installed entries.
- **Import modal is inline in the catalog page.** One call site, one file. Extracting a reusable component is speculative until a second caller appears.
- **Catalog page uses daemon routes for all data.** The merged server list comes from the daemon's `GET /api/mcp-registry/`. Search, install, check-update, and pull-update all go through the daemon. The playground's existing `GET /servers` endpoint (which only reads the in-process blessed registry) is removed. `POST /tools` stays in the playground since it needs in-process MCP client connections to fetch tool definitions, but it now queries the storage adapter and merges the result with the in-process blessed registry before resolving `serverIds` and building configs.

### Schema changes

- **`MCPSourceSchema` gains `"registry"` value.** The enum becomes `z.enum(["agents", "static", "web", "registry"])`. Registry-imported entries use `source: "registry"` — a clean discriminator that code can switch on without checking for `upstream` existence. `"web"` remains for manually-authored entries via the web UI. `"agents"` for agent-created entries. No migration: existing stored entries have `source: "web"` or `source: "agents"` and are unaffected.
- **`MCPServerMetadata` gains an optional `upstream` object** with three fields: the upstream canonical name (e.g., `io.github.toolwright-adk/linear-bootstrap`), the version string from `server.version`, and the raw `_meta.io.modelcontextprotocol.registry/official.updatedAt` string (ISO 8601 with nanosecond precision, e.g. `"2025-12-20T19:25:57.705316Z"`). Absent on blessed static entries and on user-authored manual entries; present on any entry imported via the new install route. The timestamp is stored verbatim as a string — `check-update` parses both the stored and freshly-fetched strings through `Date.parse()` and compares the resulting numbers.
- **`securityRating` for registry-imported entries defaults to `"unverified"`.** The translator stamps every successful translation with `securityRating: "unverified"`. The upstream registry carries no security metadata; hardcoding a safe default avoids false confidence and keeps the translator free of heuristic maintenance.
- **No migration.** Both fields are additive; existing stored blobs read back with `source: "web"` (or `"agents"`) and `upstream: undefined`.
- **Upstream response schemas** (not persisted) validate the subset of the registry API we consume: the list response (`/v0.1/servers`) and the version detail response (`/v0.1/servers/{name}/versions/latest`), including `_meta.io.modelcontextprotocol.registry/official.updatedAt`. The upstream `server` object has the following shape (verified against live API):
  ```ts
  type UpstreamServer = {
    $schema: string;
    name: string;             // canonical name, e.g. "io.github/Digital-Defiance/mcp-filesystem"
    description?: string;
    repository?: { url: string; source: string };
    version: string;         // e.g. "0.1.9"
    packages?: Array<{
      registryType: "npm" | "pypi" | "oci" | "mcpb";
      identifier: string;
      version: string;
      transport: { type: "stdio" };
      environmentVariables?: Array<{
        name: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
        default?: string;
        placeholder?: string;
        format?: string;
        choices?: string[];
      }>;
    }>;
    remotes?: Array<{
      type: "streamable-http" | "sse";
      url: string;            // may contain template vars like "{env}"
      headers?: Array<{        // Smithery-style auth headers; usually not user-configurable
        name: string;
        description?: string;
        isRequired?: boolean;
        value?: string;
      }>;
      variables?: Record<string, {
        description?: string;
        isRequired?: boolean;
        default?: string;
        choices?: string[];
      }>;
    }>;
  };
  ```

### API contracts

- **`GET /api/mcp-registry/search?q=&limit=`** — proxies upstream substring-on-name search via `/v0.1/servers?search=&limit=`. Returns `{ servers: [...] }` where each entry is the raw upstream server object plus `alreadyInstalled: boolean`. The `limit` default is 20. No translation occurs on this path; version selection happens on install. The `alreadyInstalled` flag is computed server-side by querying the storage adapter and checking whether any stored entry's `upstream.canonicalName` matches the result's `name`.
- **`POST /api/mcp-registry/install`** — body `{ registryName: string }`. Calls `fetchLatest(registryName)` then translates the latest version. Happy path: 201 with the stored entry. Translator reject (including unresolved URL variables): 400 with the reason. Blessed collision: 409 referencing the colliding static ID. Duplicate dynamic: 409 with the conflict ID.
- **`GET /api/mcp-registry/:id/check-update`** — always 200. Compares `storedEntry.upstream.updatedAt` against the freshly fetched `fetchLatest(id)._meta.updatedAt` by parsing both strings with `Date.parse()` and comparing the resulting numbers. `{ hasUpdate: true, remote: { updatedAt, version } }` when the remote timestamp is newer; `{ hasUpdate: false, reason }` when timestamps match or when the entry has no upstream provenance.
- **`POST /api/mcp-registry/:id/update`** — 200 with the re-translated entry on success. 400 when the entry has no upstream provenance. 400 when the upstream version can't be translated (e.g., upstream switched to docker-only between installs, or remotes gained unresolved URL variables).

### Module Boundaries

**Upstream registry HTTP client**
- *Interface:* `search(query, limit)` and `fetchLatest(canonicalName)`.
- *Hides:* base URL (`https://registry.modelcontextprotocol.io/v0.1`), URL-encoding of slashes in canonical names (e.g., `io.github/Digital-Defiance/mcp-filesystem` → `%2F`-encoded segments), upstream response Zod schemas, drift between upstream `$schema` versions.
- *Trust contract:* return values are Zod-validated against the upstream response schemas. Malformed responses throw `ZodError`; callers don't re-validate.

**Translator**
- *Interface:* one pure function `translate(rawUpstreamEntry: UpstreamServer)` returning a discriminated union: success (a validated `MCPServerMetadata`) or failure (a user-readable reason string).
- *Hides:* transport precedence rule, package selection, URL variable substitution logic, ID derivation, env-variable mapping from upstream `environmentVariables` to `RequiredConfigField[]` and `configTemplate.env`, `source`/`securityRating` stamping, `upstream` blob construction.
- *Trust contract:* on success, the returned entry is Zod-validatable against `MCPServerMetadataSchema` and ready to pass to `adapter.add()` or `adapter.update()`. On failure, the reason string is safe to include verbatim in an HTTP 400 body.
- **Environment variable mapping** from upstream `environmentVariables` (on the selected package entry) to `requiredConfig` and `configTemplate.env`:
  - `isRequired: true` → key is included in `requiredConfig` with `type: "string"`; the key is also placed in `configTemplate.env` with a placeholder string value (`"<key-name>"`)
  - `isRequired: false` → key goes into `configTemplate.env` with a placeholder string value only; NOT included in `requiredConfig`
  - `description` → mapped directly to `RequiredConfigField.description`
  - `placeholder` → appended to `description` in parentheses (e.g., `"API key (e.g. sk_live_...)"`)
  - `default` → first entry in `examples[]` if present
  - `choices` → ignored in v1 (rare; additive later)
  - `isSecret` → not mapped in v1 (no `isSecret` field on `RequiredConfigField`); future enhancement
  - `format` → ignored in v1 (no equivalent field)

**Storage adapter — new `update` method**
- *Interface:* `update(entry: MCPServerMetadata): Promise<void>`.
- *Hides:* atomic check-then-set (local KV uses versionstamp check for optimistic concurrency; Cortex uses its existing read-then-write pattern), KV key prefix, the difference between "key missing" and "concurrent write collision."
- *Trust contract:* on return, the entry is persisted at its ID. Throws if the entry doesn't exist — upstream routes always `get()` first. For local KV, uses `.atomic().check(existing).set(key, entry).commit()` to prevent lost writes from concurrent modifications.

**Daemon install route**
- *Interface:* `POST /install` with a single `registryName` field.
- *Hides:* upstream `fetchLatest`, translation, blessed-collision check, adapter call, status-code mapping.
- *Trust contract:* on 201 the entry is persisted and immediately visible via `GET /`. On 400 or 409 no state change.

**Playground `POST /tools` — per-request merge**
- The route now queries the storage adapter (`await getMCPRegistryAdapter().list()`) on every request and merges the returned dynamic entries with the in-process `mcpServersRegistry.servers` record before validating `serverIds`, checking required env vars, and building configs. The merge order is: static entries win on ID collision (same guard as the daemon's `GET /`), then dynamic entries fill the gaps. This keeps registry-imported servers resolvable at tool-connect time without requiring a daemon restart or polling loop.

### Data Isolation

Not applicable. The MCP registry is a single-tenant daemon resource and does not touch user-scoped database tables.

## Testing Decisions

Tests exercise externally observable behavior via public interfaces — not implementation. Four test files:

**Translator unit tests.** Fixture-driven: one realistic upstream JSON blob per case, assert the full returned shape. Exercises:
- Precedence rule: npm stdio wins over remote; remote wins when no npm stdio
- Multi-version search result: a fixture with two entries of the same `server.name` but different `server.version` produces two distinct successful translations with different IDs
- ID derivation: fixture names force each normalization path (dots/slashes → dashes, truncation at 64 chars, lowercasing)
- Env-variable construction: required vars produce `requiredConfig` entries + placeholder in `configTemplate.env`; optional vars produce only placeholder
- `upstream` blob: `canonicalName`, `version`, `updatedAt` all populated correctly
- URL variable substitution: `{env}` substituted from defaults; required-without-default rejected
- Security rating: every success fixture asserts `securityRating === "unverified"`
- All reject branches: sse-only, docker-only, pypi-only (no npm, no remote), no packages + no remotes, missing `server.version`, remotes with unresolved URL variables, Smithery-only remotes (headers with no user-configurable vars)
- No standalone helper tests — derivation is covered through the public `translate()` interface.

**Upstream client unit tests.** Inject a fake `fetch` function and exercise URL construction only. Three cases: `search(q, limit)` sends `?search=q&limit=N`; `fetchLatest(name)` with a slash in the name URL-encodes each segment; response with nanosecond-precision `updatedAt` parses correctly.

**Daemon route integration tests.** In-memory KV adapter + mocked client. Eight cases: install happy path (201 + persisted + `source: "registry"`); install translator reject (400 with reason); install blessed collision (409); install duplicate dynamic (409); check-update `hasUpdate: true` when remote `updatedAt` is newer numerically; check-update `hasUpdate: false` with reason when timestamps are equal; pull-update preserves the stored kebab ID through re-translation; search proxy returns `alreadyInstalled: true` for a stored entry and `false` otherwise.

**Adapter unit tests (extension).** Two cases for the new `update` method: overwrites existing entry (with versionstamp check); throws on missing ID.

**Playground route integration tests (extension).** Two cases for `POST /tools`: resolves a registry-imported server ID when the adapter contains the entry; correctly rejects an unknown server ID even after the merge.

UI components and query hooks are not covered by automated tests. The playground is local-only; manual smoke-test after the first end-to-end install is sufficient. If a concrete regression emerges, add a targeted Svelte component test for that specific bug.

**Prior art to model from:** the existing adapter-level tests in the core registry package for test shape; the `SkillsShClient` constructor's `fetchFn` injection for the HTTP client test harness; the existing `mcp-registry.test.ts` for the mocked-client + in-memory-storage route test pattern.

## Out of Scope

- **Detail / edit pages.** No per-entry detail page, no edit flow for imported entries. The catalog row is the entire UI surface for a dynamic entry. If an imported entry needs surgery, the user deletes and re-imports.
- **Docker, pypi, sse-only transports.** Rejected at install time with a clear reason. Adding support later is a translator-only change.
- **URL template variable configuration.** Remotes with required URL variables that lack defaults are rejected at install time. Full support (mapping variables to `requiredConfig`, adding URL templating to `configTemplate.transport`) is a future enhancement.
- **Multi-registry federation.** Only `registry.modelcontextprotocol.io`. Adding Glama or another aggregator is a future schema change (promote `upstream.registry` from implicit to a discriminator field) plus a new client.
- **Background update scheduling.** No cron, no auto-pull. Users trigger check and pull manually.
- **Transport disambiguation UI.** When an upstream entry has multiple packages and remotes, the translator picks silently per the precedence rule. No dropdown.
- **Authentication.** The four new routes are unauthenticated, matching the existing three registry routes. If the daemon gains multi-user auth, all seven routes become gates in the same commit.
- **Web-client support.** Playground-only for this ship. A web-client catalog + import flow would reuse the same daemon routes but needs separate UI design.
- **Rate limiting.** Upstream rate limits are undocumented. If 429s become a problem, mitigation is TanStack `staleTime` adjustment and, if needed, a small server-side backoff. Not worth pre-building.
- **Manual server editing after creation.** Once a custom server is added, the only modification path is delete-and-recreate. No inline edit form or detail-page edit mode.
- **SSE or WebSocket transport for custom servers.** Only `stdio` and `http` (streamable-http) are supported in the custom paste flow. SSE support is a future enhancement if demand exists.
- **Auto-detection of transport type from command name.** We do not try to infer whether `uvx`, `npx`, `python`, etc. imply stdio vs http. The pasted JSON determines the transport via the presence of `command`/`args` (stdio) or `url` (http).

## Further Notes

The existing blessed-server file in the consolidated registry stays. It carries curated product value the upstream doesn't provide: hand-authored LLM constraints, Link credential wiring via `{ from: "link", provider, key }`, URL-domain routing hints, tool allow-lists, and platform-specific transports (Google Workspace internal proxies). Deleting it would lose that enrichment, not duplicate metadata.

The upstream registry's substring-on-name search is adequate for a first cut but won't match on description. When users complain (e.g., "I searched 'invoice' and the billing server didn't show up"), the mitigation is an opt-in client-side description filter over the first page of results, not a change to upstream behavior.

Pull-update is included despite the temptation to defer. Skills has the same pattern and the symmetry reduces mental overhead; cost is ~15 lines + 1 test case.

The playground's existing `GET /servers` route reads only from the in-process `mcpServersRegistry` object — it doesn't see dynamic entries from the storage adapter. The new catalog page replaces this with the daemon's `GET /api/mcp-registry/` which merges both sources. The `POST /tools` route stays in the playground since it needs in-process MCP client connections to fetch tool definitions from running servers, but it now performs a per-request merge with the storage adapter so registry-imported entries are resolvable immediately after install.

Multi-version search results are a real property of the upstream API — confirmed with `io.github/Digital-Defiance/mcp-filesystem` returning versions `0.1.0` and `0.1.9` in a single search page. The install route's explicit `fetchLatest` call sidesteps this ambiguity: the search path returns raw proxy results (preserving the upstream's version diversity for display), while the install path always fetches the canonical latest before translating. This avoids silently installing a stale version.
