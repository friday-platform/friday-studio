# Review Report: Google Workspace MCP Swap Plan v1

**Review date:** 2026-04-28
**Plan reviewed:** `docs/plans/2026-04-28-google-workspace-mcp-swap-plan.md` (v1)
**Output:** `docs/plans/2026-04-28-google-workspace-mcp-swap-plan.v2.md`

## Summary

v1 is structurally sound — the phased approach (parallel-install → migrate
→ delete → harden) is the right shape. Five new issues surfaced during
deep investigation that v1 did not address. Three were resolved
interactively with the user; the remaining two (bundled-agent prompt
redesign, `auth.*` tool exposure) were folded into v2 directly.

## Investigation methodology

- Read upstream `gemini-cli-extensions/workspace` source: `index.ts`,
  `auth/AuthManager.ts`, `auth/token-storage/oauth-credential-storage.ts`,
  `auth/token-storage/hybrid-token-storage.ts`,
  `cli/headless-login.ts`, `utils/secure-browser-launcher.ts`,
  `utils/config.ts`, `features/feature-config.ts`.
- Read Friday-side current implementation: `packages/mcp/src/create-mcp-tools.ts`
  (stdio path), `packages/mcp/src/process-registry.ts` (HTTP-only design),
  `packages/core/src/mcp-registry/registry-consolidated.ts`,
  `packages/bundled-agents/src/google/calendar.ts`.
- Grep'd Google MCP ID references across Friday's tree (evals, tests,
  bundled agents, docs).
- Compared tool surfaces between workspace-mcp and the upstream extension.

## New findings (NOT in v1)

### 1. First-time OAuth blocks inside the agent's tool call (5-min timeout)

`AuthManager.getAuthenticatedClient()` (`AuthManager.ts:84-211`) opens the
browser and synchronously waits up to 5 minutes for the user to complete
OAuth — *inside the agent's MCP tool invocation*. The first Gmail tool call
in a session can hang for minutes or fail with
`"User is not authenticated. Authentication timed out."`

v1's smoke test (Phase 1.4) covers the happy path but doesn't address this
UX. **v2 makes pre-auth UX a hard Phase 1 requirement.**

**User decision (recorded):** pre-auth via playground UI.

### 2. Stdio is the only transport, with per-invocation subprocess cost

The extension only imports `StdioServerTransport` (`index.ts:10`). Friday's
existing `process-registry.ts` is HTTP-only by design (its docstring at
lines 5–10 cites workspace-mcp's port-binding TIME_WAIT issue as motivation).
Stdio MCPs go through `connectStdio` in `create-mcp-tools.ts:234`, which
spawns a fresh subprocess per agent invocation. Cold start: ~200-500ms
(node startup + module imports + AuthManager init + keychain read).

**User decision (recorded):** accept the cost; measure first; Phase 4 has
the optimization paths if needed.

### 3. `tasks.*`, `slides.write`, `sheets.write` are NOT in Google's verified GCP project

`feature-config.ts:16-17, 213, 231, 242-256` notes these scopes are not in
the published project, hence `defaultEnabled: false` upstream. Requesting
them triggers the unverified-app warning even when running through Google's
own client. v1 doesn't call this out. If Friday enables these without
disabling them via `WORKSPACE_FEATURE_OVERRIDES`, the swap *fails to fix
the warning* for those tools and the entire purpose is partially defeated.

**User decision (recorded):** only verified scopes ON by default; the new
registry entry sets `WORKSPACE_FEATURE_OVERRIDES` to disable
`tasks.read,tasks.write,slides.write,sheets.write`.

### 4. Bundled-agent prompt rewrite is more than a rename — it's a redesign

The `google-calendar` bundled agent (`packages/bundled-agents/src/google/calendar.ts:140-144`)
hardcodes workspace-mcp's tools (`list_calendars`, `get_events`,
`manage_event`, `query_freebusy`) in its system prompt. The Gemini extension
exposes a different surface: 8 calendar tools instead of 4, with the
all-in-one `manage_event` fanning out into separate `createEvent`,
`updateEvent`, `deleteEvent`, `respondToEvent` tools. v1 treats this as
"update bundled agent prompts/allowlists" — it's actually a prompt redesign
plus eval-case work.

Folded into v2 Phase 2.1 explicitly, with eval validation as a hard gate.

### 5. `auth.clear` and `auth.refreshToken` are agent-callable tools

The extension registers them at `index.ts:184-221`. Without filtering at
Friday's MCP-config layer, an agent could call `auth.clear` mid-run and
break OAuth state for everyone else using the daemon.

Folded into v2 Phase 1.3: registry entry sets
`tools: { deny: ["auth.clear", "auth.refreshToken"] }` (or equivalent
allowlist). Phase 1.5 smoke test verifies agents cannot call them.

## Other small additions in v2

- Made the Phase 0 spike explicit (30-min sanity check before investing in
  the rest).
- Enumerated the specific files needing eval/test updates instead of
  generic "update evals" — found 12+ specific files via grep.
- Called out that `process-registry.ts`'s comments/docstrings reference
  workspace-mcp specifically; consider whether the registry itself should
  stay (Phase 3.7).
- Added "scope-change re-auth UX" to Phase 4 — the extension auto-clears
  cached tokens when scopes change (`AuthManager.ts:64-73`), and Friday
  should surface this instead of letting agents discover it via a 5-min
  hang.
- Added "scope of the warning fix" preamble — explicit that the swap only
  helps for verified scopes, NOT the full Google API surface.

## Agreement / disagreement with v1

- **Agree:** phased structure, vendor-or-install options, deletion phase
  ordering, evals-as-parity-check.
- **Agree:** Phase 4 self-host caveat (verification trade-off acknowledged).
- **Disagree (minor):** v1 effort estimate "3–4 days" was optimistic;
  pre-auth UI + bundled-agent redesign push it to "4.5–6.5 days." Updated.
- **Disagree (substantive):** v1 framed the swap as "removes the unverified
  warning." It removes the warning *for the verified scope set only*.
  Important caveat for Phase 0 / decision-makers.

## Unresolved questions (forwarded to v2)

1. Multi-account support for Friday — must be answered in Phase 0
   question 4 before designing the keychain interaction.
2. Vendoring strategy — submodule recommended.
3. Whether the `google-calendar` bundled agent should be retired vs
   redesigned. Depends on whether its artifact-creation /
   summarization /failure-tracking value is worth the prompt-engineering
   investment on the new tool surface.

## Items NOT covered (out of scope for this review)

- Detailed prompt designs for the redesigned bundled agents (Phase 2.1).
- Specific UI layout for the agent-playground "Connect Google" surface
  (Phase 1.2).
- Migration path for users with existing tokens in Friday's `link`
  storage — they'll need to re-authenticate via the new flow. Probably
  acceptable, but worth flagging in release notes.
