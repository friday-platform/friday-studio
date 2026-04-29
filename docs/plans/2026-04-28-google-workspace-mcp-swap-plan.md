# Plan: Swap workspace-mcp → Gemini Workspace Extension

**Date:** 2026-04-28
**Status:** Proposed
**Owner:** TBD

## Goal

Replace Friday's 5 Python `workspace-mcp` HTTP servers + `link`-managed Google
OAuth with the upstream `gemini-cli-extensions/workspace` stdio MCP server,
which handles its own OAuth against Google's already-verified consent screen.

## Motivation

Friday's current Google OAuth client is unverified. Restricted scopes
(`gmail.modify`, `drive`, `drive.readonly`) trigger the "Google hasn't verified
this app" warning for all external users. Verification with restricted scopes
requires a CASA security assessment (annual, third-party, ~$5–15k) and 6–12
weeks of review.

The Gemini CLI Workspace Extension is Google's own product, Apache 2.0
licensed, designed for end-users to authenticate their own Google accounts
against Google's verified OAuth client. Running it as an MCP server inside
Friday means users see Google's existing consent screen — no warning — and
Friday no longer needs its own verification.

## Current state (what gets removed)

- `apps/link/src/providers/google-providers.ts` — 5 OAuth providers
  (calendar, docs, drive, gmail, sheets) with hardcoded
  `GCLOUD_CLIENT_ID` / `GCLOUD_CLIENT_SECRET`.
- `packages/core/src/mcp-registry/registry-consolidated.ts` —
  `GOOGLE_WORKSPACE_SERVICES` array (5 HTTP entries on ports 8001–8005)
  and `createGoogleWorkspaceEntry` helper. Each entry runs
  `uvx workspace-mcp --tools <service> --transport streamable-http` and
  expects `GOOGLE_<SERVICE>_ACCESS_TOKEN` from `link`.
- Friday-managed Google credential UI in `agent-playground`.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` env var docs.

## Target state

- Single stdio MCP server registered as `google-workspace`.
- Server is upstream `gemini-cli-extensions/workspace` (vendored or installed).
- Server handles its own OAuth — tokens land in OS keychain, browser flow on
  first use, no Friday consent screen.
- No `link` involvement for Google.
- Tools exposed (per `feature-config.ts`):
  `gmail.*`, `drive.*`, `docs.*`, `sheets.*`, `calendar.*`, `chat.*`,
  `slides.*`, `people.*`, `time.*`, `tasks.*`.

---

## Phase 0 — Investigation

These answers shape the rest of the plan; assumptions could be wrong. Do
before any code changes.

1. **Tool name audit.** Friday's current `workspace-mcp` exposes tools like
   `search_messages`, `send_email`, `list_events`. The Gemini extension exposes
   `gmail.search`, `gmail.send`, `calendar.listEvents`. Grep agent prompts,
   allowlists, and FSM definitions for current tool names — every reference
   needs a mapping to the new name.

   Scope: `apps/atlasd/`, `packages/agents/`, bundled agent definitions,
   `workspace.yml` examples, `tools/evals/`.

   Output: a name-mapping table.

2. **Stdio MCP launch path in Friday's daemon.** The registry already has
   stdio entries (`mcp-server-time`), but verify the daemon launches them
   with the right working directory, env passthrough, and lifecycle
   management. Especially: does it survive across Friday daemon restarts?
   Does it forward stderr to logs?

3. **Where Google MCP IDs are referenced.** Find every `google-calendar`,
   `google-gmail`, `google-drive`, `google-docs`, `google-sheets` string
   literal. They'll all need updating to either `google-workspace` (the new
   single ID) or removal.

   Likely hits: bundled agent definitions, `examples/*/workspace.yml`,
   planner prompts, eval fixtures, `agent-playground` UI labels.

4. **Multi-tenancy check.** The Gemini extension's `AuthManager` writes
   tokens to one OS-keychain entry per machine. If Friday is single-user-
   per-machine, fine. If a single Friday daemon serves multiple Google
   accounts (different workspaces, different users), pick a path:
   (a) accept single-account, (b) fork `AuthManager` to namespace tokens
   by Friday workspace ID, (c) run multiple MCP server instances with
   per-workspace credential dirs (need to confirm such an env var exists
   or has to be added).

   Decide before designing.

5. **Bundled "google-calendar agent" / "google-gmail agent" status.**
   Friday has bundled agents that wrap these MCPs (per registry
   description text). Confirm they still make sense with the new flat
   tool surface, or whether the upstream server's own tool descriptions
   are good enough that the wrapper agents become redundant.

---

## Phase 1 — Stand up the new server alongside the old

Don't delete anything yet. Run both. Prove the new path works.

1. **Vendor or install the extension.** Three options ranked by
   practicality:
   - Add as git submodule under `vendor/gemini-workspace-extension/` and
     check the built `dist/` in. Self-contained.
   - Publish a fork to npm under your org, add as devDependency, run via
     `node_modules/.bin/...`. Cleaner but more moving parts.
   - Reference an absolute local path during development; switch to
     vendored before merge.

   Build step: `npm install && npm run build` in the extension's
   directory. Output: `workspace-server/dist/index.js`.

2. **Add new MCP registry entry** in
   `packages/core/src/mcp-registry/registry-consolidated.ts` — a single
   `google-workspace` stdio entry pointing at the built `dist/index.js`
   with `--use-dot-names`. Keep the existing 5 entries untouched.

3. **Add a feature flag** (workspace config or env var) to choose
   between old and new for a given workspace. Lets you flip a single
   workspace to the new path and validate before broad rollout.

4. **Smoke-test in one workspace.** Create a minimal `workspace.yml`
   that uses `google-workspace` instead of `google-gmail`. Run a Friday
   agent that calls `gmail.search`. Verify:
   - First call triggers browser-based OAuth.
   - Token lands in keychain.
   - Subsequent calls hit cached token.
   - No "unverified app" warning.
   - Daemon restart doesn't lose auth.

---

## Phase 2 — Migrate consumers

Now flip everything pointing at the old IDs to the new one.

1. **Update bundled agent prompts/allowlists** using the name-mapping
   table from Phase 0. Tool name changes are the high-risk part — get
   this right.

2. **Update example `workspace.yml` files** in `examples/`.

3. **Update `agent-playground` UI strings** if the workspace-mcp queries
   reference specific server IDs.

4. **Update eval fixtures** (`tools/evals/agents/`) — agent name
   resolution, tool calls, expected fixtures. Run evals to confirm
   parity.

5. **Update docs.** `docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml`, anything in
   CLAUDE.md or READMEs that mentions Google OAuth setup,
   `GOOGLE_OAUTH_CLIENT_ID` env vars, or per-service MCP ports.

---

## Phase 3 — Delete the old

After Phase 2 ships and you've watched a few days of traffic without
Google-OAuth-related errors:

1. **Delete `apps/link/src/providers/google-providers.ts`** and any
   registration in the providers index.

2. **Remove the 5 `google-*` MCP entries** from
   `registry-consolidated.ts` — the `GOOGLE_WORKSPACE_SERVICES` array
   and the `createGoogleWorkspaceEntry` helper.

3. **Drop the feature flag** added in Phase 1.

4. **Remove `link`'s Google credential UI** in `agent-playground` (the
   section that shows "Connect Google Calendar", token status, etc.).
   The MCP server owns this now; Friday shouldn't show stale UI.

5. **Remove env var docs** for `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_*_ACCESS_TOKEN`,
   `GOOGLE_*_MCP_URL`, ports 8001–8005.

6. **Drop Python `workspace-mcp` from any install/setup scripts.** No
   more `uvx workspace-mcp` invocations.

---

## Phase 4 — Hardening (later, not blocking the swap)

These are improvements you'll likely want eventually:

1. **Self-host the Cloud Function.** Deploy your own Apps Script or
   Cloud Function with the same shape; set `WORKSPACE_CLOUD_FUNCTION_URL`
   to it. Removes single-point-of-failure on
   `google-workspace-extension.geminicli.com`. Note: this implies you
   also use your own `client_id`, which means your own verification —
   bringing back the original problem. Only worth doing if you
   specifically want operational independence and have the verification
   budget.

2. **Multi-account support** if Phase 0 found you need it: fork the
   `AuthManager` to namespace keychain entries by Friday workspace ID.

3. **Observability.** Pipe the server's stderr through `@atlas/logger`
   so OAuth failures and tool errors land in Friday's normal log stream.

---

## Risks (ordered by likelihood)

1. **Tool name renames break agents silently.**
   *Mitigation:* Phase 0's audit + run evals after Phase 2.

2. **Single-account-per-machine constraint conflicts with Friday's
   model.**
   *Mitigation:* catch it in Phase 0 question 4. If true, either accept
   the limit or do `AuthManager` fork in Phase 4.

3. **Cloud Function gets blocked/rate-limited by Google.**
   *Mitigation:* monitor for it; have Phase 4 step 1 ready as the
   contingency.

4. **Stdio MCP server lifecycle bugs in Friday's daemon.**
   *Mitigation:* Phase 1 step 4 catches this; if issues exist, fix the
   daemon's stdio MCP support, since `mcp-server-time` already needs
   it to work too.

5. **`--use-dot-names` vs default underscore form** — pick one in Phase
   1 and don't waver. Dot-names match existing Friday conventions;
   flipping later means re-doing the tool name mapping.

---

## Estimated effort

| Phase | Work | Effort |
|---|---|---|
| 0 | Investigation: grep + reading | 0.5 day |
| 1 | Parallel install + flag + smoke test | 0.5–1 day |
| 2 | Migrate consumers (agents, evals, docs) | 1–2 days |
| 3 | Delete old, mechanical | 0.5 day |
| | **Total focused work** | **3–4 days** |
| | + eval run time, review cycles | |

## Open questions

- Which install option for Phase 1 (submodule / npm fork / local path)?
  Recommend submodule for self-containment.
- Multi-account support: needed for Friday's product, or can we accept
  single-account-per-machine?
- Are the bundled `google-calendar` / `google-gmail` wrapper agents
  worth keeping after the swap, or can they be retired?
