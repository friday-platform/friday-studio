<!-- v2 - 2026-04-28 - Generated via /improving-plans from docs/plans/2026-04-28-google-workspace-mcp-swap-plan.md -->

# Plan: Swap workspace-mcp → Gemini Workspace Extension (v2)

**Date:** 2026-04-28
**Status:** Proposed
**Owner:** TBD
**Supersedes:** `2026-04-28-google-workspace-mcp-swap-plan.md` (v1)

## Goal

Replace Friday's 5 Python `workspace-mcp` HTTP servers + `link`-managed Google
OAuth with the upstream `gemini-cli-extensions/workspace` stdio MCP server,
which handles its own OAuth against Google's already-verified consent screen.

## Motivation

Friday's current Google OAuth client is unverified. Restricted scopes
(`gmail.modify`, `drive`, `drive.readonly`) trigger the "Google hasn't verified
this app" warning for all external users. Verification with restricted scopes
requires a CASA security assessment (annual, third-party, ~$5–15k) and
6–12 weeks of review.

The Gemini CLI Workspace Extension is Google's own product, Apache 2.0
licensed, designed for end-users to authenticate their own Google accounts
against Google's verified OAuth client. Running it as an MCP server inside
Friday means users see Google's existing consent screen — no warning — and
Friday no longer needs its own verification.

## Scope of the warning fix — be explicit

**The swap removes the warning ONLY for scopes Google has verified in their
published GCP project.** The extension's `feature-config.ts:16-17, 213, 231,
242-256` notes that `slides.write`, `sheets.write`, and `tasks.*` are NOT in
the published verified project — these have `defaultEnabled: false` upstream
because requesting them triggers the unverified-app warning even when running
through Google's client.

Default policy in this swap: **only verified scopes ON by default** (set via
`WORKSPACE_FEATURE_OVERRIDES`). Users who want unverified Google scopes are no
better off than they are today — that's a separate problem this swap doesn't
attempt to solve.

## Current state (what gets removed)

- `apps/link/src/providers/google-providers.ts` — 5 OAuth providers (calendar,
  docs, drive, gmail, sheets) with hardcoded `GCLOUD_CLIENT_ID` /
  `GCLOUD_CLIENT_SECRET`.
- `packages/core/src/mcp-registry/registry-consolidated.ts` —
  `GOOGLE_WORKSPACE_SERVICES` array (5 HTTP entries on ports 8001–8005) and
  `createGoogleWorkspaceEntry` helper. Each entry runs
  `uvx workspace-mcp --tools <service> --transport streamable-http` and
  expects `GOOGLE_<SERVICE>_ACCESS_TOKEN` from `link`.
- `packages/bundled-agents/src/google/calendar.ts` — bundled agent referencing
  workspace-mcp tool names (`list_calendars`, `get_events`, `manage_event`,
  `query_freebusy`) and `linkRef: { provider: "google-calendar", ... }`.
- Friday-managed Google credential UI in `agent-playground`.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` env var docs.

## Target state

- Single stdio MCP server registered as `google-workspace`.
- Server is upstream `gemini-cli-extensions/workspace` (vendored or installed).
- Server handles its own OAuth — tokens land in OS keychain (or encrypted
  file fallback via `HybridTokenStorage`), browser flow on first use, no
  Friday consent screen.
- No `link` involvement for Google.
- Tools exposed (per upstream `feature-config.ts`):
  `gmail.*`, `drive.*`, `docs.*`, `sheets.*`, `calendar.*`, `chat.*`,
  `slides.*`, `people.*`, `time.*`, `tasks.*`.
- `tasks.*`, `slides.write`, `sheets.write` disabled by default via
  `WORKSPACE_FEATURE_OVERRIDES`.
- `auth.clear`, `auth.refreshToken` denied at the Friday MCP-config layer
  (agents must not be able to nuke OAuth state).
- Pre-auth UX in `agent-playground` (NOT inside the agent's tool call).

---

## Phase 0 — Investigation + spike

Before any production-bound code, do a 30-minute spike: build the upstream
extension locally, register a stdio MCP entry pointing at it, run a Friday
agent that calls one tool. Confirm the architecture works end-to-end before
investing in the rest.

Then answer the structural questions:

1. **Tool name + surface audit.** This is more than renames. Compare the two
   surfaces side-by-side:
   - workspace-mcp Calendar: `list_calendars`, `get_events`, `manage_event`,
     `query_freebusy`.
   - extension Calendar: `calendar.list`, `calendar.listEvents`,
     `calendar.getEvent`, `calendar.findFreeTime`, `calendar.createEvent`,
     `calendar.updateEvent`, `calendar.deleteEvent`, `calendar.respondToEvent`.

   The single workspace-mcp `manage_event` fans out into 4 specific tools.
   Bundled-agent prompts need *redesign*, not find-replace. Output: a
   side-by-side mapping table per service.

   Scope: `apps/atlasd/`, `packages/agents/`, `packages/bundled-agents/`,
   bundled agent definitions, `workspace.yml` examples, `tools/evals/`.

2. **Stdio MCP launch path.** Friday's `process-registry.ts` is HTTP-only by
   design — it solves the workspace-mcp port-binding problem. Stdio MCP goes
   through `connectStdio` in `packages/mcp/src/create-mcp-tools.ts:234`, which
   spawns a fresh subprocess **per agent invocation**. Cold start cost:
   node startup (~100ms) + module imports (~100-200ms) + `AuthManager` init
   + keychain read (~50ms each). Decision (locked-in for v2): **accept the
   cost, measure first**. Optimize only if evals/users complain. Phase 4 has
   the optimization options if needed.

3. **Where Google MCP IDs are referenced.** Find every `google-calendar`,
   `google-gmail`, `google-drive`, `google-docs`, `google-sheets` string
   literal:
   - `tools/evals/agents/planner/routing.eval.ts` (multiple)
   - `tools/evals/agents/planner/resources.eval.ts`
   - `tools/evals/agents/planner/crud-suppression.eval.ts`
   - `tools/evals/agents/email-gmail-classification/email-gmail-classification.eval.ts`
   - `tools/agent-playground/src/lib/server/routes/mcp.test.ts`
   - `packages/bundled-agents/src/google/calendar.ts`
   - `packages/bundled-agents/src/email/communicator.ts` (mentions
     `google-gmail` MCP in its `constraints` text)
   - `packages/bundled-agents/src/slack/communicator.ts` (mentions
     `google-gmail` MCP in `constraints`)
   - `packages/bundled-agents/src/fathom-ai/get-transcript.ts` (mentions
     `google-calendar`)
   - `docs/plans/2026-04-27-workspace-creation-redesign-handoff-brief.md`

4. **Multi-tenancy decision.** The extension's `OAuthCredentialStorage`
   (`oauth-credential-storage.ts:11-12`) uses hardcoded
   `KEYCHAIN_SERVICE_NAME = 'gemini-cli-workspace-oauth'` and
   `MAIN_ACCOUNT_KEY = 'main-account'`. **Single Google account per machine
   for the entire daemon.** If Friday is single-user-per-machine, fine. If
   multi-tenant, decide: (a) accept the limit, (b) fork the storage layer to
   namespace by Friday workspace ID, (c) run multiple subprocess instances
   with `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true` plus per-workspace
   working directories (still requires forking the file path logic).
   **Confirm Friday's product model before designing.**

5. **Bundled `google-calendar` agent — keep, redesign, or retire?** The
   extension's flat tool surface (with read/write split) is rich enough
   that an LLM agent given direct access can do calendar work without a
   wrapper. Decide whether the bundled agent's value (artifact creation,
   summarization, fail-tool semantics) is worth re-implementing on the new
   surface, or whether agents that need calendar access just enable
   `google-workspace` directly and call calendar tools themselves.

---

## Phase 1 — Stand up the new server alongside the old

Don't delete anything yet. Run both. Prove the new path works end-to-end.

1. **Vendor or install the extension.** Three options:
   - Add as git submodule under `vendor/gemini-workspace-extension/` and
     check the built `dist/` in. Self-contained.
   - Publish a fork to npm under your org, add as devDependency, run via
     `node_modules/.bin/...`. Cleaner but more moving parts.
   - Reference an absolute local path during development; switch to vendored
     before merge.

   Build step: `npm install && npm run build` in the extension's directory.
   Output: `workspace-server/dist/index.js`.

2. **Pre-auth UX in agent-playground.** This is the headline UX item.
   Add a "Connect Google account" action in the workspaces UI that:
   - Spawns the extension's headless OAuth flow OUT-OF-BAND (not via an
     agent's tool call).
   - Shows OAuth status (connected / not connected / scopes granted).
   - Displays a "Disconnect" button that runs `auth.clear` (the only legit
     consumer of that tool — agents must not have it).
   - Surfaces the `extension login` subcommand so headless / SSH users can
     pre-auth without a browser on the host.

   The extension already exposes a `login` subcommand
   (`workspace-server/src/cli/headless-login.ts`) that prints an OAuth URL
   and reads pasted creds from `/dev/tty`. Use that for headless users.

   **Why this is required, not optional:** `AuthManager.getAuthenticatedClient()`
   (`AuthManager.ts:84-211`) opens the browser and waits up to 5 minutes
   inside the agent's tool call. Without pre-auth, the first Gmail tool call
   in any session hangs the agent. With pre-auth, the agent never blocks.

3. **Add new MCP registry entry** in
   `packages/core/src/mcp-registry/registry-consolidated.ts` — a single
   `google-workspace` stdio entry with:
   - `command: "node"`, `args: ["<path>/workspace-server/dist/index.js", "--use-dot-names"]`
   - `env: { WORKSPACE_FEATURE_OVERRIDES: "tasks.read,tasks.write,slides.write,sheets.write" }`
     to disable scopes outside Google's verified set.
   - `tools: { deny: ["auth.clear", "auth.refreshToken"] }` (or an explicit
     allowlist that excludes them) so agents cannot nuke OAuth state.
   - No `requiredConfig` — OAuth handled by the server itself. Pre-auth in
     agent-playground is a separate flow.

   Keep the existing 5 entries untouched.

4. **Add a feature flag** (workspace config or env var) to choose between
   old and new for a given workspace. Lets you flip a single workspace to
   the new path and validate before broad rollout.

5. **Smoke-test in one workspace.**
   Create a minimal `workspace.yml` that uses `google-workspace` instead of
   `google-gmail`. Verify:
   - Pre-auth via playground UI lands tokens in keychain.
   - Daemon restart preserves auth.
   - First call hits cached token; no browser pops up.
   - No "unverified app" warning during pre-auth.
   - Calling a `tasks.*` tool (deliberately disabled) returns a clear
     "tool not enabled" error and DOES NOT trigger an OAuth flow for
     unverified scopes.
   - Calling `auth.clear` from inside an agent fails (denied at config layer).
   - Concurrent agent runs share the same keychain credentials cleanly.

---

## Phase 2 — Migrate consumers

Now flip everything pointing at the old IDs to the new one. Order matters:
do prompts/logic FIRST, then evals (so eval failures are real signal, not
stale test data).

1. **Bundled agents — redesign, don't rename.**
   - `packages/bundled-agents/src/google/calendar.ts`: rewrite the system
     prompt for the new tool surface (8 calendar tools instead of 4).
     Update `linkRef` removal + `mcp` block to reference `google-workspace`
     server with `tools: { allow: [...] }` listing only the calendar tools
     the agent needs. Update `tool-progress` event names. Update
     `writeToolNames` set. Add eval cases for the new prompt.
   - `packages/bundled-agents/src/email/communicator.ts`: update its
     `constraints` text — replace `google-gmail MCP` with the new server
     name and updated tool semantics.
   - `packages/bundled-agents/src/slack/communicator.ts`: same as above.
   - `packages/bundled-agents/src/fathom-ai/get-transcript.ts`: same.

2. **Update example `workspace.yml` files** in `examples/`.

3. **Update `agent-playground` UI strings** — workspace MCP queries
   (`tools/agent-playground/src/lib/queries/workspace-mcp-queries.ts`)
   reference specific server IDs in test fixtures and possibly in UI labels.

4. **Update planner / classification prompts.**
   - `tools/evals/agents/planner/routing.eval.ts`: routing test cases use
     `expectedCapabilities: ["google-gmail"]` etc. Update to new IDs.
   - `tools/evals/agents/email-gmail-classification/email-gmail-classification.eval.ts`:
     decision tree references `google-gmail` MCP literally. Update prompt
     and assertion text.
   - `tools/evals/agents/planner/crud-suppression.eval.ts` and
     `resources.eval.ts`: capability strings.

5. **Update tests that hardcode workspace-mcp launch shape.**
   - `packages/core/src/mcp-registry/discovery.test.ts:238,266,281`:
     `args: ["workspace-mcp"]` literals.
   - `packages/core/src/mcp-registry/registry.test.ts:114`: same.
   - `packages/mcp/src/process-registry.test.ts:90`: same.
   - `packages/mcp/src/create-mcp-tools-startup.test.ts:121,161`: same.

6. **Update docs.** `docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml`, anything in
   CLAUDE.md or READMEs that mentions Google OAuth setup,
   `GOOGLE_OAUTH_CLIENT_ID` env vars, or per-service MCP ports.

7. **Run evals.** Confirm parity (or document deltas) before Phase 3.

---

## Phase 3 — Delete the old

After Phase 2 ships and you've watched a few days of traffic without
Google-OAuth-related errors:

1. **Delete `apps/link/src/providers/google-providers.ts`** and any
   registration in the providers index.

2. **Remove the 5 `google-*` MCP entries** from `registry-consolidated.ts`
   — the `GOOGLE_WORKSPACE_SERVICES` array and the
   `createGoogleWorkspaceEntry` helper.

3. **Drop the feature flag** added in Phase 1.

4. **Remove `link`'s Google credential UI** in `agent-playground`. The MCP
   server owns this now; Friday shouldn't show stale UI. Replace with the
   new "Connect Google account" surface from Phase 1.

5. **Remove env var docs** for `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_*_ACCESS_TOKEN`,
   `GOOGLE_*_MCP_URL`, ports 8001–8005.

6. **Drop Python `workspace-mcp` from any install/setup scripts.** No more
   `uvx workspace-mcp` invocations.

7. **Audit `process-registry.ts`'s comments and docstrings.** They mention
   workspace-mcp specifically as the motivating example. Update or simplify
   if the registry is now used by zero MCP servers (and consider whether
   the registry itself should stay).

---

## Phase 4 — Hardening (later, not blocking the swap)

These are improvements you'll likely want eventually:

1. **Self-host the cloud function.** Deploy your own Apps Script or Cloud
   Function with the same shape; set `WORKSPACE_CLOUD_FUNCTION_URL` to it.
   Removes single-point-of-failure on
   `google-workspace-extension.geminicli.com` for both initial auth AND
   token refresh (every ~1h, per `AuthManager.refreshToken()` at
   `AuthManager.ts:238`). Note: this implies you also use your own
   `client_id`, which means your own verification — bringing back the
   original problem. Only worth doing if you specifically want
   operational independence and have the verification budget.

2. **Multi-account support** if Phase 0 found you need it: fork the
   `OAuthCredentialStorage` layer to namespace keychain entries by Friday
   workspace ID. Roughly 30 lines of code, but it's a fork — locks you out
   of upstream updates.

3. **Stdio shared-process registry** if cold-start cost from Phase 1.5
   becomes a problem. Two implementation paths:
   - Generalize `process-registry.ts` to handle stdio children (not just
     HTTP). Match its lifecycle semantics — single process per `serverId`,
     daemon-scoped.
   - Wrap the extension behind a thin HTTP-to-stdio bridge process; reuses
     existing HTTP registry. Adds a moving part.

4. **Observability.** The extension uses its own `logToFile` (see
   `setLoggingEnabled(true)` via `--debug`). Output doesn't land in
   Friday's `@atlas/logger` stream. Wrap stderr → `@atlas/logger` so OAuth
   failures and tool errors show up in Friday's normal log channels.

5. **Scope-change re-auth UX.** When Friday changes the enabled feature set
   (different scopes), `AuthManager.loadCachedCredentials()`
   (`AuthManager.ts:64-73`) detects missing scopes and clears the token,
   forcing re-auth on next request. Ensure the playground UI surfaces
   "scopes changed, please re-connect" cleanly rather than letting agents
   discover this via a 5-minute hang.

---

## Risks (ordered by likelihood)

1. **Bundled-agent prompt redesign breaks agent behavior silently.**
   The Calendar agent's prompt is tied to specific tool names and the
   `manage_event` all-in-one shape. New surface = new model behavior =
   possible regressions in event creation, freebusy, etc.
   *Mitigation:* Phase 0's audit + run evals after Phase 2. Add new eval
   cases targeting the new tool surface specifically.

2. **First-time OAuth blocks inside agent tool calls (without pre-auth UX).**
   *Mitigation:* Phase 1.2 makes pre-auth a hard requirement, not optional.

3. **Single-account-per-machine breaks multi-tenant Friday installs.**
   *Mitigation:* Phase 0 question 4. Decide before designing.

4. **Cold-start latency degrades agent performance noticeably.**
   *Mitigation:* Phase 1.5 smoke-test measures it; Phase 4 has the
   optimization paths if needed.

5. **Cloud Function gets blocked / rate-limited / goes down.**
   *Mitigation:* monitor for it; have Phase 4 step 1 ready as the
   contingency. Note: token refresh is also affected, not just initial
   auth — a Cloud Function outage would degrade all Google ops within ~1h
   of token expiry.

6. **`auth.*` tools expose dangerous mutations to agents if not denied.**
   *Mitigation:* Phase 1.3 mandates the registry-level deny. Test for it
   in Phase 1.5.

7. **Forgetting `WORKSPACE_FEATURE_OVERRIDES` re-introduces the warning.**
   *Mitigation:* Phase 1.3 sets it explicitly in the registry entry's
   `env`. Add a Phase 1.5 smoke-test case that verifies a disabled tool
   does not trigger an OAuth flow.

8. **`--use-dot-names` vs default underscore form.** Picking dot-names
   matches Friday's `serverId/toolName` prefix convention seen in the
   workspace-creation-redesign brief. Once chosen in Phase 1, do not
   waver — flipping later means re-doing every prompt and allowlist.

9. **Tests in `packages/mcp/` and `packages/core/src/mcp-registry/` hardcode
   workspace-mcp launch shape.** Easy to miss, fail noisily.
   *Mitigation:* Phase 2.5 enumerates the test files explicitly.

---

## Estimated effort

| Phase | Work | Effort |
|---|---|---|
| 0 | 30-min spike + investigation/grep + decisions | 0.5–1 day |
| 1 | Vendor + pre-auth UI + registry entry + flag + smoke test | 1.5–2 days |
| 2 | Migrate bundled agents + evals + tests + docs | 2–3 days |
| 3 | Delete old, mechanical | 0.5 day |
| | **Total focused work** | **4.5–6.5 days** |
| | + eval run time, review cycles | |

The pre-auth UI work + bundled-agent prompt redesign push v2 estimates
above v1's "3–4 days." Both are non-negotiable for a clean ship.

## Open questions

- **Multi-account support: needed for Friday's product, or accept
  single-account-per-machine?** Locked-in for v2 only after Phase 0
  question 4 answers it.
- **Vendoring strategy for Phase 1.1: submodule / npm fork / local path?**
  Recommend submodule for self-containment.
- **Are the bundled `google-calendar` wrapper agent's value-adds (artifact
  creation, summarization) worth re-implementing on the new tool surface,
  or can agents just call calendar tools directly?**

## Decisions locked in (from v1 review)

- **Auth UX:** pre-auth via playground UI. No in-agent OAuth blocking.
- **Cold-start cost:** accept it for the swap. Measure, optimize later if
  evals/users complain.
- **Default scope policy:** only Google-verified scopes ON by default.
  `tasks.*`, `slides.write`, `sheets.write` disabled via
  `WORKSPACE_FEATURE_OVERRIDES`.
