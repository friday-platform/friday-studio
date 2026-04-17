# Review: whatsapp-telegram-multi-adapter

**Date:** 2026-04-16
**Branch:** main (uncommitted; shared worktree)
**Verdict:** Needs Work

## Summary

Wired WhatsApp + Telegram chat adapters to coexist in a single workspace and
unbroke env-based credential loading (secrets now stay in `~/.atlas/.env`
instead of `workspace.yml`). End-to-end verified live against Meta and
Telegram. Two real bugs to fix before committing; a handful of Karpathy-worthy
cleanups; pre-existing noise in the diff should be pulled out of any PR that
lands this work.

## Critical

None. The GET-verify fallback is not a security hole — the WhatsApp adapter
re-validates `WHATSAPP_VERIFY_TOKEN` inside `handleVerificationChallenge`
(confirmed at
`node_modules/@chat-adapter/whatsapp@4.26.0/…/dist/index.js:452`:
`token === this.verifyToken`).

## Important

### 1. `envFileFlags()` precedence is inverted relative to the comment

`scripts/dev-watcher.ts:33-37`. Empirical test:
```
deno eval --env-file=a --env-file=b ...   # b wins
deno eval --env-file=b --env-file=a ...   # a wins
```
Deno `--env-file` is **last-wins**, not first-wins as the `--help` text
suggests. Current order is `ATLAS_HOME_ENV` first then `REPO_ENV`, so if a
repo-root `.env` ever exists (CI, teammate scaffolding) it silently overrides
the user's `~/.atlas/.env`. No `.env` in this repo today, so latent.

**Fix:** swap order to `[REPO_ENV, ATLAS_HOME_ENV]` so user-specific env
wins, and update the comment.
**Worth doing: Yes** — 2-line fix, prevents a confusing future footgun.

### 2. `credentialId = resolved[0]?.credentialId` silently drops the non-primary credential

`apps/atlasd/src/atlas-daemon.ts:1267`. Comment claims "analytics & teardown
routing" but teardown calls `chat.shutdown()` which fans out to all adapters
(`chat-sdk-instance.ts:393`). So `credentialId` is analytics-only. With
Telegram + WhatsApp both resolved, WhatsApp's credentialId is lost.

**Fix:** either delete the field and its wiring (teardown doesn't need it —
simplest, minimum code) or widen to `credentialIds: string[]`. Prefer
deletion unless analytics actually consumes it somewhere downstream.
**Worth doing: Yes** — surgical, 1–5 LOC. Removes a latent analytics hole
the moment someone adds a dashboard keyed by credentialId.

### 3. GET-verify fallback is ambiguous when multiple WhatsApp workspaces exist

`apps/atlasd/routes/signals/platform.ts:150-158`. The fallback
`findWorkspaceByProvider(daemon, "whatsapp")` returns the **first** matching
workspace. With two WhatsApp workspaces both relying on env-based
`WHATSAPP_VERIFY_TOKEN`, the adapter of workspace A is asked to verify
workspace B's challenge. Adapter-side validation still works (same env var
→ same secret), so not security-critical, but logs become confusing and
future per-workspace routing will silently break.

**Fix:** when the explicit lookup fails and more than one whatsapp workspace
exists, log a warn naming them. Leave routing behavior as-is for now.
**Worth doing: Yes** — 3 LOC, saves a future debugging session.

### 4. Test coverage gaps on the new multi-adapter path

`apps/atlasd/src/chat-sdk/adapter-factory.test.ts` added exactly one new
case. Missing (all parametric rows, `it.each`):
- `tgWaSignals` + only-telegram creds → `["atlas", "telegram"]`
- `tgWaSignals` + only-whatsapp creds → `["atlas", "whatsapp"]`
- Credentials for a provider whose signal is absent (telegramCreds +
  httpSignals) → `["atlas"]` (current code: early-returns on empty
  providers; worth locking in)

`resolvePlatformCredentials` has no direct test in `chat-sdk-instance.test.ts`
— the new array return path, tg+wa both resolving, Slack-only-when-empty
fallback, and env-var fallback are all untested.

`apps/atlasd/routes/signals/platform.test.ts` covers Slack POST only. The
new GET-verify fallback has no route test at all. Add three cases:
explicit verify_token match, fallback match, no-whatsapp-workspace → 403.

**Worth doing: Yes** — each is a single `it.each` row (~3 LOC) or a small
route-test block. Highest-leverage additions.

## Needs Decision

### A. Proactive WhatsApp token-expiry warning

Meta's *temporary* access token rotates every 24h. `thread_post_failed`
surfaces the 403 only after a user-visible failure. A daemon-startup HEAD
to `graph.facebook.com/v21.0/me` would warn at load. Worth shipping now, or
defer until System User tokens are the norm?

### B. Slack silently skipped when signal creds resolve

`chat-sdk-instance.ts:67-70`. A workspace with a Telegram signal that also
has a Slack app wired through Link will drop the Slack adapter. Probably
fine (Slack-via-Link is a different onboarding flow), but if you ever add
a Telegram signal to a Slack-connected workspace for testing, Slack
disappears without warning. Worth a log line at least.

## Pre-existing (not this session's work — pull out of any PR)

These appear in `git diff HEAD` but pre-date this session's commits:

- `logger: "silent"` → `logger: "info"` at `chat-sdk-instance.ts:373` —
  makes every inbound message log at info level; looks like leftover
  debug scaffolding.
- `resolveTelegramCredentials` mutates `signal.config.bot_token_suffix` —
  hidden coupling with `findWorkspaceByProvider("telegram", "bot_token_suffix", …)`.
- `packages/config/src/signals.ts`, `packages/core/src/chat/*`,
  `apps/atlasd/package.json`, `deno.lock` — teammate-owned changes from
  the pre-declaw/chat-unify work. Review separately.
- `tools/agent-playground/src/lib/components/chat/user-chat.svelte` and
  friends — playground UI work, not related to platform credentials.

**Per CLAUDE.md shared-worktree rule:** when this lands, stage only the
session-owned files by name (`git add apps/atlasd/src/chat-sdk/*
apps/atlasd/src/atlas-daemon.ts apps/atlasd/routes/signals/platform.ts
apps/webhook-tunnel/src/routes.ts scripts/dev-watcher.ts
apps/atlasd/src/chat-sdk/adapter-factory.test.ts
docs/integrations/whatsapp/ docs/integrations/telegram/`), never
`git add .`.

## Minor

- `thread_post_failed` logs `{name, message}` only — consistent with other
  `chat_sdk_*` errors in the file, skip unless Sentry grouping needs stack.
- `adapter-factory.ts:30` comment "in factory lookup order" is now stale
  (iteration is over credentials list, not `CHAT_PROVIDERS`). Trim the
  phrase.
- Duplicate-kind in credentials array silently overwrites via
  `adapters[creds.kind] = buildAdapter(creds)` — last-wins. Fine as spec;
  consider a debug log if it matters for multi-bot setups.
