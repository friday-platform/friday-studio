# Daemon shutdown fix — team lead learnings

## Pre-implementation findings

- The HTTP `/api/daemon/shutdown` endpoint at `apps/atlasd/routes/daemon.ts:17-25` was an early stub by Lukasz Jagiello (initial commit `eb919c8`, 2026-05-01) and predated Kenneth Kouot's parallel-shutdown work in `0f54829` (2026-05-04). The bug is not a regression — the route was never updated to call `process.exit` after Kenneth introduced the proper signal-handler shutdown path.
- Kenneth's commit `0f54829` deliberately made `withShutdownTimeout` warn-and-continue: "One hung component can no longer block the rest." Any fix that makes timeouts blocking would regress this. The signal-aware refactor preserves this — abort fires AND warn fires AND we proceed.
- Kenneth's commit `a0a8720` already established that `ChatTurnRegistry.drainShutdown()` must complete before NATS dies, encoded in `_doShutdown()` ordering at `atlas-daemon.ts:2499` (drain) before `:2580` (NATS stop). Daemon-wide root AbortController would have re-introduced the bug; we use step-local controllers via `withShutdownTimeout` instead.

## Tooling / process

- The team task list (created via `TeamCreate`) is separate from the global TaskList. Tasks created BEFORE the team exist only in the global list, so teammates spawned into the team can't `TaskList` them. Embed full task descriptions in the spawn prompt or recreate tasks inside the team list.

## Mid-implementation observations

- Prescribed `Deno.metrics()` in the task contract for #13's watchdog diagnostic, but `Deno.metrics()` was removed from Deno's public API. Should have verified the call before writing it into the spec; flagged via `deno check` once Po started editing. Replaced with `Deno.memoryUsage()`. Lesson: when an adversarial-review agent suggests an API, verify it exists in the current Deno version before canonicalizing it in a task contract.
- Wave 1 file overlap check held: #13 (`routes/daemon.ts` + new test), #14 (`atlas-daemon.ts:175-197`), #18 (`code-exec.ts` + `workspace-chat.agent.ts`) — all disjoint, parallel safe.
- Caught one new `as` cast in Ferox's first #18 commit. Ferox was mirroring the pre-existing `const execErr = err as {...}` pattern in the same file, but that's pre-existing tech debt and the no-`as` rule is hard. `in` narrowing replaced both. Lesson worth capturing: when teammates are extending a file with existing `as` patterns, the canonical answer is "don't add new `as`" even if the pattern is local convention. Could be a CLAUDE.md note.

## Recurring issue: `as` casts in new code

Two teammates (Ferox in #18, Luka in #19) independently added `as` casts in their first commits — both following pre-existing patterns in the local file or codebase. The "no `as`" rule is on the hard-rule list but is being treated as advisory by agents matching local convention.

Patterns observed:
- Ferox: `(err as { name?: unknown }).name === "AbortError"` after `"name" in err` — fix: `in` narrowing makes the cast unnecessary.
- Luka: `(captured?.reason as Error).message` after `toBeInstanceOf(Error)` assertion — fix: `String(captured?.reason)` or `instanceof` narrowing in an if-block.

CLAUDE.md gap candidate: explicit guidance that `unknown === string` is a valid strict-equality comparison after `in` narrowing, AND that test code is not exempt from the rule. The "follow existing patterns" instinct is overriding the hard-rule list.

Both cases were one-line revisions. Cost is small per occurrence but the pattern recurring across teammates suggests a doc fix is overdue.

## `as` rule pattern firmed up

Now THREE teammates have each independently added `as` casts in their first commit despite the hard-rule list:
- Ferox (#18): `(err as { name?: unknown }).name` — fix: `in` narrowing
- Luka (#19): `(captured?.reason as Error).message` — fix: `String(captured?.reason)`
- Po (#13): two casts — `process.env as Record<string,string>` and `await response.json() as {...}` — fixes: `NodeJS.ProcessEnv` natural type, `toMatchObject`/Zod

This is now firmly a CLAUDE.md gap. Recommended addition:
- Explicit no-`as`-in-tests note (test files are not exempt)
- Three idioms to reach for instead: `in` narrowing, `instanceof` narrowing, Zod parsing for unknown-shape data
- `process.env` typed as `NodeJS.ProcessEnv` (not Record<string,string>) — common gotcha when constructing child env

## Subprocess-test gotchas (from #13)

Po's commit `823a78a` surfaced two test-infra learnings worth promoting beyond a single PR:

1. `@atlas/logger` short-circuits all output when `DENO_TESTING=true` (logger.ts:19). The vitest test runner sets this via `deno task test` in deno.json. **Any test that spawns a child daemon and parses its logs MUST `delete childEnv.DENO_TESTING`** or the child appears completely silent. Sara should consider documenting this in a test conventions doc.
2. Deno rejects `OTEL_DENO=""` (empty string) with a startup warning; only `"true"`/`"false"` are accepted. **Strip OTEL env vars by `delete`, never blank them**.

## #17 closed the smoking gun (Almond, commit e0f67dd)

Almond's investigation surfaced an architectural detail worth promoting: NATS.js 2.29.x's `Consumer.delete()` is DESTRUCTIVE — it tears down the durable consumer entry on the broker. The non-destructive way to break a pending `consumer.fetch()` is `ConsumerMessages.close()` on the iterator returned BY `fetch()` (not on the Consumer itself).

The default JetStream `expires` of 10s was the silent budget shutdown was paying every time a SIGTERM landed during an idle fetch — visible only as "the daemon takes 10s to exit", not as an obvious stall.

Almond also caught a bonus fix: closing the iterator on the no-signal stop path covered the same `expiresMs` stall for callers that call `stop()` directly (without a shutdown signal). Quietly fixed in the same commit.

## `deno task lint` is destructive

`deno task lint apps/atlasd/` invokes `biome check --write` which auto-applies formatter fixes to the working tree. Caught me by surprise during final verification — assumed it was read-only. Result: 3 files were silently modified after they'd already been committed, requiring a follow-up "fmt" commit to clean state.

If the project standardizes on `deno task lint` as a CI command, it should not auto-fix in dev. Recommend adding a `deno task lint:check` (read-only) and a `deno task lint:fix` (write). Or invoke biome directly with `--no-fixes` for verification flows.

## Wave summary — what shipped

8 substantive commits + 4 cast-removal follow-ups + 1 biome fmt = 13 commits total on this branch. Per-task lineage:

- #14 (Luka, 72b280a) — `withShutdownTimeout` signal-aware refactor; foundation for #15/#16/#17
- #18 (Ferox, 99a1256 + 7d91404) — `run_code` subprocess signal threading; closes orphan-bash dangling handle
- #19 (Luka, f2206fc + 6419254) — unit tests for the new shape; caught and fixed sync-throw bug in #14
- #13 (Po, 823a78a + 3ab4496) — HTTP `/shutdown` route exits + 15s watchdog + integration test (TRACER BULLET)
- #15 (Luka, 11fb797) — `Deno.serve` signal plumbing
- #16 (Ferox, d05899a) — `NatsManager.stop` race-and-close fallback
- #17 (Almond, e0f67dd) — JetStream consumer iterator close on abort (smoking gun)

#20 (manual smoke) deferred to Sara per spec.
