# Review v3: whatsapp-telegram-multi-adapter

**Date:** 2026-04-16
**Branch:** main (uncommitted)
**Verdict:** Clean — ship it.

## Summary

Narrow follow-up pass on the three polish items from v2 review. All three
landed cleanly with no regressions. 36/36 chat-SDK tests + 332/332 config
tests still green.

## v2 polish items — status

| # | Item | Landed | Evidence |
|---|---|---|---|
| 1 | Path diagrams fixed (3 files) | ✅ | `apps/atlasd/routes/signals/platform.ts:87-93` shows internal `/signals/telegram/<suffix>` with external `/platform/telegram/<suffix>` via tunnel rewrite. Both READMEs (`whatsapp/README.md:15-32`, `telegram/README.md:11-28`) match `atlas-daemon.ts:741` mount and `webhook-tunnel/routes.ts` pass-through. |
| 2 | Dead `bot_token_suffix` removed | ✅ | `packages/config/src/signals.ts:57-67` — schema is `{ bot_token, webhook_secret }` only. Repo-wide grep finds zero live references (only v1/v2 review docs + regression-test comment + a tunnel URL-path-label comment — all appropriate). |
| 3 | `as ChatProvider` cast → type guard | ✅ | `apps/atlasd/src/chat-sdk/adapter-factory.ts:102-104` — `isChatProvider(value): value is ChatProvider`. Narrows cleanly inside the `if`. Remaining `as` usages in the file are `as const` + `as readonly string[]`, both CLAUDE.md-permitted. |

## Critical

None.

## Important

None introduced. No regressions.

## Tests

No test changes required or recommended.

- `isChatProvider` is already exercised via `adapter-factory.test.ts`'s
  unknown-provider case (discord/httpSignals) and multi-known-provider
  cases. A dedicated unit test for the guard would be redundant.
- Schema removal has zero backward-compat risk: no YAML fixtures, no
  external consumers of `TelegramProviderConfigSchema`, no references in
  `COMPREHENSIVE_ATLAS_EXAMPLE.yml` (Telegram isn't in it).
- Regression-guard test at `chat-sdk-instance.test.ts:426` ("does NOT
  mutate signal config") gets *stronger* now that the mutated field is
  also gone from the schema.

## Needs Decision

### A. Pre-existing `as Record<string, unknown>` casts in platform.ts

`apps/atlasd/routes/signals/platform.ts:276, 331` — still use
`(cfg as Record<string, unknown>)[configKey]` for dynamic signal-config
indexing. CLAUDE.md prefers `"key" in obj` narrowing. Not in scope of
this session (pre-existing), flagged so it doesn't rot further.
**Worth doing: defer** — three tiny casts, no correctness risk, touching
them in this PR blurs scope.

All other items from v1/v2 review resolved.
