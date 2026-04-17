# Review v2: whatsapp-telegram-multi-adapter

**Date:** 2026-04-16
**Branch:** main (uncommitted; shared worktree)
**Verdict:** Clean (minor polish worth a follow-up commit)

## Summary

Round-two pass after the v1 findings landed. All 13 requested fixes shipped
cleanly and the test suites grew from 5 → 11 (adapter-factory), +0 → +6
(`resolvePlatformCredentials`), and +0 → +4 (GET `/whatsapp` route). Two
latent doc/comment path errors and one dead schema field are the only items
worth touching before ship.

## v1 findings — status

| # | Finding | Landed |
|---|---|---|
| 1 | `credentialId?` removed from `ChatSdkInstance` | ✅ |
| 2 | `whatsapp_verify_ambiguous_fallback` warn log on fallback | ✅ `platform.ts:167` |
| 3 | `envFileFlags` order swapped to `[REPO_ENV, ATLAS_HOME_ENV]` | ✅ `dev-watcher.ts:42` |
| 4 | `resolveTelegramCredentials` no longer mutates signal.config | ✅ + regression test at `chat-sdk-instance.test.ts:429` |
| 5 | `logger: "silent"` restored | ✅ `chat-sdk-instance.ts:396` |
| 6 | Slack fallback logs `slack_credential_shadowed_by_signal_creds` | ✅ `chat-sdk-instance.ts:68-80` |
| 7 | 8-frame stack on `thread_post_failed` | ✅ (8 is fine — adapter errors surface through 4-6 frames with headroom) |
| 8 | "in factory lookup order" comment trimmed | ✅ |
| 9 | `platform_adapter_duplicate_kind_overwritten` log on duplicate-kind | ✅ `adapter-factory.ts:90` |
| 10 | Hand-rolled `validateWhatsappAccessToken` probe removed | ✅ |
| 11 | Regex token-expiry hint removed; doc troubleshooting added | ✅ |
| 12 | `resolveSlackCredentials` try/catches fetch errors | ✅ `chat-sdk-instance.ts:175-186` |
| 13 | `as keyof typeof cfg` replaced with `in` + typed indexing | ✅ `platform.ts:273` |

## Critical

None.

## Important

### 1. Webhook path diagrams + one code comment misdescribe atlasd routes

Atlasd mounts `createPlatformSignalRoutes` at `/signals`
(`atlas-daemon.ts:741`), so the internal route is `/signals/whatsapp` and
`/signals/telegram/<suffix>`. The *external* tunnel URL is
`/platform/<provider>/<suffix>` — webhook-tunnel rewrites that to
atlasd's `/signals/...`. Three places still show the external prefix on
the internal path:

- `apps/atlasd/routes/signals/platform.ts:89` code comment:
  `https://<host>/api/signals/platform/telegram/<bot_token_suffix>` —
  misleading for anyone debugging directly against `localhost:8080`.
- `docs/integrations/whatsapp/README.md:17` ASCII diagram: `/signals/platform/whatsapp`
- `docs/integrations/telegram/README.md:13` ASCII diagram: `/signals/platform/telegram/:suff`

User-facing curl snippets in both READMEs use the tunnel URL and are
correct; only the "how it works" diagrams and the internal-only comment
mislead.

**Recommendation:** rewrite all three to show the true atlasd route
(`/signals/<provider>[/<suffix>]`) and add a one-line note that the
tunnel layer prefixes `/platform` externally.
**Worth doing: Yes** — ~5 lines across three files, diagrams are
load-bearing when something breaks.

### 2. Dead field `bot_token_suffix` still in the Zod schema

`packages/config/src/signals.ts:62-65` still declares
`bot_token_suffix: z.string().optional()` with description "populated at
runtime from bot_token". The runtime population was removed in this PR
(and the regression test at `chat-sdk-instance.test.ts:429` locks it in
as never-mutated), so the field is dead. Leaving it in the schema
invites someone to hand-write it into `workspace.yml`; no code path
reads it.

**Recommendation:** delete the field and its description.
**Worth doing: Yes** — per CLAUDE.md's "remove dead code entirely" rule;
trivial diff.

### 3. `provider as ChatProvider` cast still present

`apps/atlasd/src/chat-sdk/adapter-factory.ts:110` — after
`(CHAT_PROVIDERS as readonly string[]).includes(provider)` narrows the
value, `seen.add(provider as ChatProvider)` uses an `as` cast. CLAUDE.md
forbids `as` except for `as const` on string literals; a user-defined
type guard is a one-line fix:

```ts
function isChatProvider(x: string): x is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(x);
}
```

Then `if (provider && isChatProvider(provider)) seen.add(provider);`.

**Worth doing: Yes** — respects house rule, one line.

## Tests

**Solid overall.** 36/36 passing. New coverage closes every gap v1 called
out.

### Remaining gap worth closing

**`apps/atlasd/routes/signals/platform.test.ts` has no coverage for
`POST /whatsapp`** (event delivery — the actual production traffic path).
The new suite only exercises GET verify handshakes. Worth mirroring the
Slack POST tests (routing by `phone_number_id`, 400 on invalid payload,
404 on no matching workspace).

**Worth doing: Yes** — it's the hot path; the GET tests alone give false
confidence.

### Other gaps (not worth closing)

- `whatsapp_verify_ambiguous_fallback` log path — pure logging branch,
  routing already covered by sole-workspace fallback test.
- `slack_credential_shadowed_by_signal_creds` warn — requires mocking
  `fetchLinkCredential`, log-only side effect.

### Vitest nit (not blocking)

`chat-sdk-instance.test.ts:17-19` — `createChat`/`getChat`/`deleteChat`
stubs use untyped `vi.fn()`. No test reads them, so benign. Either drop
them or type them to match the rest of the file (line 11 is correctly
typed).

### Strategy choices that are fine

- `resolvePlatformCredentials` tests force Slack fetch failure by setting
  `LINK_SERVICE_URL=http://127.0.0.1:1`. Port 1 requires root to bind →
  guaranteed ECONNREFUSED on unprivileged test runners. Cross-platform
  reliable.
- `afterAll` env restoration is correct; Vitest isolates env per worker.
- `JSON.stringify` mutation guard is adequate for the realistic regression
  mode (config[key] assignment).

## Needs Decision

### A. `envFileFlags` relies on empirical Deno behavior

Deno's `--env-file` is empirically last-wins but the CLI docs read
first-wins. If Deno flips semantics in a point release, `~/.atlas/.env`
silently stops overriding repo `.env` — and the daemon continues
starting cleanly, just with wrong values.

**Options:** (a) accept the risk (simplest), (b) add a daemon-startup
sentinel check (`ATLAS_ENV_SENTINEL=home` from `~/.atlas/.env`; boot-log
warns if it didn't win), (c) stop relying on Deno's env-file ordering
and read+merge env files ourselves in `dev-watcher.ts`.

Not urgent — no `.env` exists in the repo today. Worth flagging so it's
not a surprise later.
