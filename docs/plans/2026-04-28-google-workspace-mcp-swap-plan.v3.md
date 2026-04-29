<!-- v3 - 2026-04-28 - Generated via /improving-plans from docs/plans/2026-04-28-google-workspace-mcp-swap-plan.v2.md -->

# Plan: Replace Friday's Google OAuth client with the Gemini extension's verified flow

**Date:** 2026-04-28
**Status:** Proposed
**Owner:** TBD
**Supersedes:** `2026-04-28-google-workspace-mcp-swap-plan.v2.md` (full MCP swap)

## What changed from v2

v2 proposed swapping the entire MCP layer (Python `workspace-mcp` →
Gemini's stdio MCP server). After deeper review, that approach paid for
benefits we don't need — bundled-agent prompt redesign, user workspace
migration, subprocess cold-start cost, single-account constraint, tool
context bloat — all to solve one problem: **the unverified-app warning.**

The unverified-app warning comes from Friday's hardcoded OAuth client
(`121686085713-...`) being unverified. Tokens issued by Google are opaque
Bearer tokens — workspace-mcp's API calls don't care which client_id minted
the token, only that Google accepts it. So **we can keep Friday's entire
existing MCP/agent stack and only replace the OAuth client identity**:

- Stop using Friday's `121686085713` client + hardcoded secret.
- Use Gemini extension's verified client `338689075713` via the Cloud
  Function-based flow.
- Tokens flow into Friday's existing `link` storage and out to workspace-mcp
  via `GOOGLE_<SERVICE>_ACCESS_TOKEN` env vars exactly as today.

Result: ~2-3 days of focused work instead of v2's 4.5-6.5. None of v2's
ergonomic regressions. None of the bundled-agent rewrites.

## Goal

Replace Friday's hardcoded Google OAuth client (`121686085713` +
`GCLOUD_CLIENT_SECRET`) with a delegated OAuth flow that uses Gemini
extension's verified client and Cloud Function for code→token exchange.
Everything else in Friday — workspace-mcp servers, bundled agents, link
credential storage, agent prompts — stays intact.

## Posture caveat (read this)

Running Gemini's MCP server unmodified = "user is running Google's
published software." Extracting Gemini's OAuth client_id and using it from
Friday's branded code = "Friday is making OAuth requests as Google's
published app." The same `client_id` is in flight, but the shape is
different. Specifically:

- **OAuth consent screen will say "Gemini CLI Workspace Extension"** — not
  Friday Studio. Users will see Google's branding when authorizing.
- **Tokens are issued to Google's app, used by Friday.** Google's TOS for
  OAuth clients prohibits using a third-party's published client_id from
  a different app. We are doing this knowingly. Google can revoke / rate-
  limit / block the Cloud Function at any time, breaking Friday's Google
  integration overnight.
- **Mitigation horizon:** if/when this becomes load-bearing for Friday,
  the durable fix is Friday's own verified GCP project + CASA assessment
  for restricted scopes. This plan is explicitly tactical.

User has signaled awareness and acceptance of this. Documented here so
future readers don't trip over it.

## Architecture

### Today

```
Friday daemon
  └─ link
      └─ Google OAuth provider (static mode)
          ├─ client_id = 121686085713-... (Friday's, UNVERIFIED)
          ├─ client_secret = GOCSPX-... (hardcoded, shipped in binary)
          └─ token_endpoint = https://oauth2.googleapis.com/token
              ↓ direct exchange
            Google issues token for Friday's client
              ↓ stored in link
            workspace-mcp gets GOOGLE_<SERVICE>_ACCESS_TOKEN env var
              ↓ Bearer auth to gmail.googleapis.com etc.
            ✓ works, but consent screen shows "unverified app" warning
```

### After this swap

```
Friday daemon
  └─ link
      └─ Google OAuth provider (NEW: delegated mode)
          ├─ client_id = 338689075713-... (Google's, VERIFIED for Gemini ext)
          ├─ NO client_secret (it stays in Cloud Function)
          ├─ authorization_endpoint = https://accounts.google.com/o/oauth2/v2/auth
          │     redirect_uri = https://google-workspace-extension.geminicli.com
          │     state = base64({uri, manual:false, csrf})  ← Cloud Function format
          ├─ Cloud Function exchanges code → tokens, redirects to
          │     <whatever URL was in state.uri>
          │     ?access_token=...&refresh_token=...&expiry_date=...
          │     &scope=...&token_type=...&state=<csrfToken>
          │     (note: returned `state` is the CSRF string, NOT the
          │      original base64 payload — see cloud_function/index.js:116)
          └─ refresh_endpoint = https://google-workspace-extension.geminicli.com/refreshToken
              ↓ POST {refresh_token} → {access_token, expiry_date,
                                        token_type, scope}
              (no refresh_token in response — Google never returns one
               on refresh; Friday must preserve original)
            workspace-mcp unchanged: receives env var, makes API calls
              ↓
            ✓ works, no warning (consent screen is Gemini's, not Friday's)
```

## Concrete file-level changes

### 1. New "delegated" mode in `apps/link/src/providers/types.ts`

`OAuthConfig` is currently a union of `discovery` and `static`. Add a third
variant:

```typescript
| {
    /** Delegated mode: token exchange happens in an external endpoint that
     *  redirects back with pre-exchanged tokens in query params.
     *  Used for OAuth flows where the client_secret lives server-side
     *  (e.g., Gemini Workspace Extension's Cloud Function). */
    mode: "delegated";
    /** OAuth authorization endpoint (Google's, etc.) */
    authorizationEndpoint: string;
    /** External redirect URI passed to Google. The endpoint at this URL
     *  performs the code→token exchange and redirects to Friday's callback
     *  with tokens in query params. */
    delegatedExchangeUri: string;
    /** Endpoint to POST to for token refresh. Receives {refresh_token},
     *  returns {access_token, expires_in, token_type, scope}. */
    delegatedRefreshUri: string;
    /** OAuth client ID (no secret — secret lives in delegated endpoint). */
    clientId: string;
    /** Default scopes to request. */
    scopes: string[];
    /** State payload encoder. Returns base64-encoded JSON in the format
     *  the delegated endpoint expects. */
    encodeState: (input: { csrfToken: string; finalRedirectUri: string }) => string;
    /** Additional query parameters for authorization endpoint. */
    extraAuthParams?: Record<string, string>;
  }
```

### 2. Implement delegated flow in `apps/link/src/oauth/`

Two new modules:

- **`oauth/delegated.ts`** — equivalent of `static.ts` but for the new mode:
  - `buildDelegatedAuthUrl(config, csrfToken, finalRedirectUri)` — builds the
    auth URL with `redirect_uri = config.delegatedExchangeUri` and the
    custom state payload.
  - `parseDelegatedCallback(searchParams, expectedCsrf)` — extracts tokens
    from the query params Friday's callback receives. Validates the
    returned `state` query param **equals** `expectedCsrf` (not base64-
    decoded — the Cloud Function strips the payload and forwards only
    the CSRF, per `cloud_function/index.js:116`). Reads
    `access_token`, `refresh_token`, `expiry_date` (already absolute
    epoch ms — no conversion), `scope`, `token_type`. Maps
    `expiry_date` → Friday's `expires_at`.
  - `refreshDelegatedToken(config, refreshToken)` — POSTs JSON
    `{refresh_token}` to `config.delegatedRefreshUri`. Response is
    `{access_token, expiry_date, token_type, scope}` — **no
    `refresh_token` in response**; caller must preserve the original.
    Endpoint accepts both `/refresh` and `/refreshToken` paths.

- **`oauth/service.ts` callback path** — current code assumes a `code`
  query param and runs a code→token exchange via `oauth4webapi`. Add a
  branch: if the provider's mode is `delegated`, skip the exchange and
  call `parseDelegatedCallback` to extract pre-exchanged tokens.

- **`oauth/tokens.ts` refresh path** — same shape: branch on mode, call
  `refreshDelegatedToken` for delegated providers.

### 3. Replace `apps/link/src/providers/google-providers.ts`

Drop `GCLOUD_CLIENT_ID = "121686085713-..."` and
`GCLOUD_CLIENT_SECRET = "GOCSPX-..."`. Use Gemini's verified client + Cloud
Function:

```typescript
const GEMINI_CLIENT_ID = "338689075713-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com";
const GEMINI_EXCHANGE_URI = "https://google-workspace-extension.geminicli.com";

function encodeGeminiState({ csrfToken, finalRedirectUri }) {
  // Format from AuthManager.ts:319-325. The Cloud Function:
  //   - decodes this base64 payload
  //   - validates payload.uri is localhost or 127.0.0.1
  //     (cloud_function/index.js:97-103)
  //   - redirects to payload.uri with token query params
  //   - in the redirect, sets ?state=<csrf> (NOT the base64 payload)
  return Buffer.from(JSON.stringify({
    uri: finalRedirectUri,   // full URL incl. path, e.g.
                             // "http://localhost:3100/v1/providers/google/callback"
    manual: false,           // true = show JSON for SSH/headless paste flow;
                             // Friday is always desktop-with-localhost so false
    csrf: csrfToken,
  })).toString("base64");
}

function createGoogleProvider(service, displayName, description) {
  return defineOAuthProvider({
    id: `google-${service}`,
    displayName,
    description,
    oauthConfig: {
      mode: "delegated",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      delegatedExchangeUri: GEMINI_EXCHANGE_URI,
      delegatedRefreshUri: `${GEMINI_EXCHANGE_URI}/refreshToken`,
      clientId: GEMINI_CLIENT_ID,
      scopes: ["openid", "email", ...GOOGLE_SCOPES[service]],
      extraAuthParams: {
        access_type: "offline",
        prompt: "consent",   // mandatory: only way to guarantee Google
                             // returns a refresh_token on the auth code
                             // exchange (per AuthManager.ts:335)
      },
      encodeState: encodeGeminiState,
    },
    identify: async (tokens) => { /* unchanged */ },
  });
}
```

### 4. Verify Friday's `link` callback URL is localhost-bound

The Cloud Function (`cloud_function/index.js:97-103`) **only redirects to
`localhost` or `127.0.0.1`** — it rejects any other hostname for the
`payload.uri`. Friday Studio's launcher runs the daemon on the user's
machine, and `link` listens on `localhost:3100` per `apps/link/CLAUDE.md`.
Friday's existing OAuth callback is therefore already localhost-bound.

Action: confirm the callback URL passed to `encodeGeminiState` resolves
to `http://localhost:3100/...` (or whichever port link binds). If link
is ever moved to a hosted URL, this entire flow breaks.

## Phase plan

### Phase 0 — Spike (30 min)

Standalone Node script (no Friday integration, no link):

1. Generate auth URL with Gemini's `client_id`, redirect_uri = Cloud
   Function, state with localhost callback.
2. Open URL in browser, complete consent.
3. Local HTTP server on `localhost:<random>` receives the redirect.
4. Parse tokens from query params.
5. Call `gmail.googleapis.com/gmail/v1/users/me/profile` with the access
   token — confirm the response is 200 OK.
6. Call `${GEMINI_EXCHANGE_URI}/refreshToken` with the refresh_token —
   confirm fresh tokens come back.

If all six steps work, the architecture is proven; proceed.

### Phase 1 — `delegated` OAuth mode in link (1-1.5 days)

1. Add `delegated` mode to `OAuthConfig` in `apps/link/src/providers/types.ts`.
2. Implement `oauth/delegated.ts` with auth URL builder, callback parser,
   refresh function. Tests.
3. Branch in `oauth/service.ts` callback handler — if provider is
   delegated mode, parse tokens from query params instead of running
   code-exchange. Add tests for both branches.
4. Branch in `oauth/tokens.ts` refresh path — call `refreshDelegatedToken`
   for delegated providers. Tests.
5. Update Zod schemas in `oauth/discovery.ts` / `oauth/registration.ts`
   if they enumerate modes.

### Phase 2 — Wire Gemini's flow into Google providers (0.5 day)

1. Edit `apps/link/src/providers/google-providers.ts` to use `delegated`
   mode with Gemini's client_id and Cloud Function URLs.
2. Remove `GCLOUD_CLIENT_ID` / `GCLOUD_CLIENT_SECRET` constants.
3. Verify Friday-side scopes (`gmail.modify`, `drive`, `drive.readonly`,
   `calendar`, `documents`, `spreadsheets`) are a subset of what
   Gemini extension's verified GCP project covers (`feature-config.ts`
   lines 84, 96, 122, 70, 228, 174 confirm: yes).

### Phase 3 — End-to-end verification (0.5 day)

For each of `google-calendar`, `google-gmail`, `google-drive`,
`google-docs`, `google-sheets`:

1. Trigger OAuth flow from agent-playground.
2. Confirm consent screen has NO "unverified app" warning.
3. Confirm consent screen says "Gemini CLI Workspace Extension"
   (expected, document for users).
4. Confirm tokens land in link's credential storage.
5. Confirm workspace-mcp receives the token via env var and makes a
   successful API call.
6. Wait ~1h or force token refresh; confirm refresh via Cloud Function
   succeeds.

### Phase 4 — Cleanup

1. Remove docs / setup scripts referencing `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` if those env vars were ever exposed.
2. Update CLAUDE.md / README sections that explain Friday's Google OAuth
   to note the delegated flow + Cloud Function dependency.
3. Add a short note in the OAuth provider catalog / agent-playground UI
   explaining "Authorizing via Gemini CLI Workspace Extension" so users
   aren't confused by the consent screen branding.

### Phase 5 — Hardening (later, not blocking)

1. **Self-host the Cloud Function.** Deploy a Friday-controlled equivalent
   (Apps Script or Cloud Function) that knows the `client_secret`. Set
   `GEMINI_EXCHANGE_URI` to point at it. Note: this means using Friday's
   own `client_id` again, which puts you back in the unverified-app
   problem unless you also pursue verification. **Only worth it if Google
   blocks the public Cloud Function or you want operational independence
   AND have verification budget.**

2. **Token-refresh resilience.** The Cloud Function `/refreshToken` is now
   on the critical path for every Google API call after the first hour.
   Add retry + circuit breaker semantics in `refreshDelegatedToken` so a
   transient outage doesn't kill all Google integrations across all users
   simultaneously.

3. **Observability.** Log Cloud Function calls (initial exchange + refresh)
   to `@atlas/logger` with request IDs. Useful when diagnosing whether a
   user-facing failure is a Google issue, a Cloud Function issue, or a
   Friday issue.

## What does NOT change

These all stay exactly as they are today:

- workspace-mcp servers (Python, ports 8001-8005, `--tools` filtering)
- Bundled `google-calendar` agent (`packages/bundled-agents/src/google/calendar.ts`)
- Tool names (`list_calendars`, `get_events`, `manage_event`, etc.)
- MCP registry entries (`google-calendar`, `google-gmail`, `google-drive`,
  `google-docs`, `google-sheets`)
- All eval files (`tools/evals/agents/planner/routing.eval.ts` etc.)
- Test fixtures referencing workspace-mcp launch shape
- User workspace.yml files
- agent-playground UI (mostly — small note about Gemini branding)
- The HTTP-only `process-registry.ts` and its lifecycle semantics
- `link`'s credential storage, RLS, multi-tenant model

This is the entire reason this plan beats v2 on cost.

## Risks (ordered by likelihood)

1. **Cloud Function gets blocked / rate-limited / shut down.**
   Hard dependency on `https://google-workspace-extension.geminicli.com`.
   *Mitigation:* monitor 4xx/5xx rates from the Cloud Function. Phase 5.1
   self-host is the contingency.

2. **Google revokes Gemini's client OR enforces TOS against third-party
   use of their published OAuth client.** Less likely, but breaks Friday's
   Google integration entirely, no graceful degradation.
   *Mitigation:* treat as outage. Communicate honestly with users. Have
   Phase 5.1 ready as a fallback even if expensive.

3. **Cloud Function's localhost-only redirect restriction breaks if link
   ever moves to a non-localhost URL.** Today link runs on `localhost:3100`
   on the user's machine, so we're fine. If Friday ever splits link into
   a hosted service, this flow breaks.
   *Mitigation:* document the constraint in `apps/link/CLAUDE.md`. Add a
   regression test that fails loudly if the callback resolves to a non-
   localhost URL.

4. **State payload format drift.** The Cloud Function's expected `state`
   shape (`{uri, manual, csrf}`) is undocumented and could change. If
   Gemini's team modifies it, our `encodeGeminiState` produces invalid
   states.
   *Mitigation:* monitor for callback errors after every Cloud Function
   redeploy. Subscribe to the gemini-cli-extensions/workspace repo.

5. **Token refresh failures cascade.** Every API call after ~1h hits
   `/refreshToken`. Outage there → all Google ops fail.
   *Mitigation:* Phase 5.2 retries + circuit breaker. Cache refreshed
   tokens aggressively (link probably already does).

6. **Scope drift.** If Friday adds a Google scope (`tasks.write`,
   `chat.spaces`, etc.) that Gemini's verified project doesn't cover,
   the swap silently re-introduces the unverified-app warning for that
   scope.
   *Mitigation:* document the verified-scope set in
   `google-providers.ts`. Reference `gemini-cli-extensions/workspace`'s
   `feature-config.ts` as the source of truth. Add a CI check or a code
   comment that gates new scopes on Gemini's verified set.

7. **OAuth consent screen branding confuses users.** "Gemini CLI Workspace
   Extension is requesting access to your Google account" — users may
   abort thinking it's not Friday.
   *Mitigation:* Phase 4.3 — explanatory copy in agent-playground at the
   moment we send the user to OAuth.

## Estimated effort

| Phase | Work | Effort |
|---|---|---|
| 0 | Spike: standalone OAuth + API call + refresh | 0.5 day |
| 1 | `delegated` mode + auth/refresh/callback in link | 1–1.5 days |
| 2 | Wire Gemini config into google-providers.ts | 0.5 day |
| 3 | End-to-end verification per service | 0.5 day |
| 4 | Cleanup (docs, env vars, UI copy) | 0.5 day |
| | **Total focused work** | **2–3 days** |

Compare to v2's 4.5–6.5 days — same problem solved, much less risk and
disruption.

## Open questions

- **Should the new `delegated` mode be reusable for other delegated-secret
  providers?** Yes, by design — the abstraction has no Gemini-specific
  hardcoding. If Friday later adds another integration with a third-party
  Cloud Function-style flow (e.g., GitHub App via your own backend), this
  mode covers it.
- **UI copy for the consent-screen branding mismatch.** Need product
  input. Suggest: "You'll be redirected to Google to authorize Friday via
  the Gemini CLI Workspace integration." Vague but honest.
- **Telemetry on Cloud Function failures.** Worth a separate small task —
  what's the SLI/SLO for "Friday Google integrations work"?

## Decisions locked in (carried from prior reviews)

- Use Gemini extension's verified OAuth client.
- Don't pursue Friday-side verification (too expensive for the value).
- Posture: TOS-leaning, accept the risk, plan a self-host escape hatch.
