# Review Report: Google Workspace MCP Swap Plan v2

**Review date:** 2026-04-28
**Plan reviewed:** `docs/plans/2026-04-28-google-workspace-mcp-swap-plan.v2.md` (v2)
**Output:** `docs/plans/2026-04-28-google-workspace-mcp-swap-plan.v3.md`

## Summary

v2 was solving the right *problem* (unverified-app warning) but with the
wrong *scope*. v2 swapped the entire MCP layer — Python `workspace-mcp`
servers → Gemini's stdio MCP server — paying the cost of bundled-agent
prompt redesigns, user workspace migration, subprocess cold-start, single-
account constraints, and tool context bloat. All to fix the OAuth client
identity that triggers the warning.

**v3 narrows the scope to just the OAuth client.** Tokens are opaque
Bearer tokens — workspace-mcp doesn't care which `client_id` minted them.
By replacing only Friday's hardcoded credentials with a delegated flow
that uses Gemini's verified client + Cloud Function, we keep the entire
existing MCP/agent stack intact. ~2-3 days of work instead of v2's 4.5-6.5.

## Investigation methodology

- Re-read upstream `gemini-cli-extensions/workspace`:
  - `cloud_function/index.js` — full token-exchange and `/refreshToken`
    handlers, including the localhost-only redirect restriction
    (lines 97-103) and CSRF state forwarding (line 116).
  - `workspace-server/src/auth/AuthManager.ts` — full OAuth flow
    including state encoding (lines 319-325), localhost callback server
    (lines 304-413), and refresh path (lines 221-271).
  - `workspace-server/src/utils/paths.ts` — token storage paths (key
    finding for v2 critique).
  - `workspace-server/src/auth/scopes.ts` — confirmed Friday's scope
    set is a subset of Gemini's verified set.
- Re-read Friday-side OAuth provider system:
  - `apps/link/src/providers/types.ts` — current OAuth provider modes
    (`discovery`, `static`).
  - `apps/link/src/oauth/static.ts` — token endpoint client auth.
  - `apps/link/src/oauth/` — full directory structure (callback, refresh,
    state, registration, etc.).
- Verified Friday's existing constraints:
  - `link` runs on `localhost:3100` per `apps/link/CLAUDE.md` —
    compatible with Cloud Function's localhost-only redirect.
  - Friday's scope set in `google-providers.ts` (`gmail.modify`, `drive`,
    `drive.readonly`, `calendar`, `documents`, `spreadsheets`) is fully
    contained in Gemini's `feature-config.ts` verified scope set.

## Major architectural pivot in v3

v2 was "swap the MCP server." v3 is "swap the OAuth client identity."
This was prompted by the user asking: "can we just extract how auth
works and still use our MCP once we have a token?"

The answer is yes, and the plan collapses dramatically:

| Concern | v2 | v3 |
|---|---|---|
| Bundled-agent prompt redesign | Required (calendar.ts) | Not needed |
| User workspace.yml migration | Required (alias / auto-migrate) | Not needed |
| Tool context bloat | Real (50 tools in 1 server) | N/A — tools unchanged |
| Subprocess cold-start cost | Real (~200-500ms per call) | N/A |
| Single-account-per-machine | Required forking storage | N/A — link multi-tenant unchanged |
| `auth.*` tool exposure | Required deny | N/A — no auth tools exposed |
| 5-min in-agent OAuth timeout | Required pre-auth UX | Already solved by link |
| Test/eval rewrites | 12+ files | Minimal (OAuth provider tests) |
| Effort | 4.5-6.5 days | 2-3 days |

## New findings (NOT in v1 or v2 reviews)

### 1. v2 was over-scoped — token client_id doesn't propagate to API calls

The fundamental insight: workspace-mcp uses tokens as Bearer auth
against `gmail.googleapis.com`, `drive.googleapis.com`, etc. Google's
API endpoints validate tokens by:
- Signature / not-revoked
- Not-expired
- Has-required-scope

The `client_id` that minted the token is metadata for billing/audit, not
a runtime check. So we can use Gemini's client_id to mint tokens, then
hand them to workspace-mcp, and Google's APIs accept them.

v2 didn't recognize this — it assumed the entire MCP layer needed to
move with the OAuth flow. v3 corrects this.

### 2. Token storage path issues v2 raised are now MOOT

v2 was about to surface findings around `paths.ts`'s `findProjectRoot()`
walking up to find `gemini-extension.json`, token files landing inside
the project tree, npm install wiping tokens, Mac app bundles being
read-only at runtime. **None of that matters in v3** — Friday's `link`
already handles credential storage. The Gemini extension's storage layer
is bypassed entirely.

### 3. The Cloud Function's redirect-to-localhost restriction works in Friday's favor

`cloud_function/index.js:97-103` rejects any `payload.uri` whose hostname
isn't `localhost` or `127.0.0.1`. This would have been a constraint if
Friday's `link` were a hosted service. It isn't — `link` runs on
`localhost:3100` on the user's machine via the Friday daemon
(`apps/link/CLAUDE.md`). Compatible by construction.

Worth flagging as a future risk: if Friday ever splits link into a
hosted service, this flow breaks.

### 4. The state parameter on the callback is the CSRF string, not the base64 payload

A subtle protocol detail: AuthManager sends `state = base64({uri, manual,
csrf})` to Google. Google passes that state through to the Cloud
Function. The Cloud Function decodes the base64, extracts `csrf`, and
forwards `?state=<csrf>` (the bare string) to Friday's localhost
callback. Friday's callback validator must compare `received_state ===
csrf_token` directly, NOT base64-decode it.

Easy to get wrong on first implementation — flagged in v3 with a comment.

### 5. Token refresh response shape: no `refresh_token` returned

`cloud_function/index.js:319-326`: on refresh, the response is
`{access_token, expiry_date, token_type, scope}` only. Google never
returns a fresh `refresh_token` on refresh — the original must be
preserved. v3 calls this out in the `refreshDelegatedToken` contract.

## Confirmed posture caveats

The user has accepted these knowingly; recording them so future readers
don't re-litigate:

1. **OAuth consent screen will say "Gemini CLI Workspace Extension."**
   Not a misconfiguration — Friday is using Google's published app's
   OAuth client. Phase 4 explanatory UI copy mitigates user confusion.

2. **Using Google's OAuth client from Friday is TOS-leaning.** Different
   shape from "running Google's MCP server" (which is just running
   Apache 2.0 software). Google can revoke the client / Cloud Function /
   block Friday's traffic at any time. Mitigation horizon is Phase 5.1
   (self-host Cloud Function) — but that re-introduces the verification
   problem unless paired with Friday-side verification.

3. **Scope set frozen to Gemini's verified set.** Adding a new Google
   scope outside that set silently re-introduces the unverified-app
   warning. v3 risk #6 covers this; recommend a code comment in
   `google-providers.ts` linking to upstream `feature-config.ts`.

## Agreement / disagreement with v2

- **Agree on the original problem framing:** unverified-app warning is
  the issue, full verification is too expensive.
- **Disagree on the solution scope:** v2's MCP swap solves the warning
  AND a bunch of things that aren't broken. v3 surgically replaces only
  the broken thing (the OAuth client).
- **Agree on Phase 5 self-host caveat:** verification trade-off is
  unchanged.
- **Agree on Cloud Function as single-point-of-failure:** v3 inherits
  this risk, with the same mitigation path.

## Items folded into v3 directly (no question to user)

- Specific protocol details: state encoding, callback parsing,
  refresh response shape, `prompt: 'consent'` requirement.
- File-level concrete changes: new `delegated` mode in `OAuthConfig`,
  branches in `oauth/service.ts` callback and `oauth/tokens.ts` refresh,
  rewrite of `google-providers.ts`.
- Localhost-callback constraint: confirmed compatible with current
  Friday architecture; flagged as future risk if `link` is ever moved.

## Unresolved questions (forwarded to v3)

1. **UI copy for the consent-screen branding mismatch** — needs product
   input. Suggested wording in v3 Phase 4.3.
2. **Telemetry/SLO for the Cloud Function dependency** — separate task,
   not blocking the swap.
3. **Whether Phase 5.1 self-host is on the roadmap or accepted as a
   theoretical contingency.**

## Items NOT covered (out of scope)

- v2's full investigation of stdio MCP infrastructure — moot for v3.
- v2's bundled-agent prompt redesign — moot.
- v2's user workspace.yml migration — moot.
- Detailed implementation of `oauth/delegated.ts` — left for the
  implementer with the contract specified in v3.

## Note for future reviewers

If Google does revoke / rate-limit the public Cloud Function, v3 fails
abruptly. The fallback options (in priority order):

1. Self-host Cloud Function with Friday's own client_id + Friday-side
   verification (expensive, slow).
2. Revert to v2 (run the actual Gemini MCP server).
3. Accept Friday's old unverified flow with the warning.

v3 explicitly defers this question. Worth revisiting whichever quarter
the swap actually ships, by which time Cloud Function reliability data
will be available.
