# Review: chat UX — stream resume, non-blocking input, tool-call grouping

**Date:** 2026-04-16
**Branch:** declaw
**Commits:** `6d7ec481f2`, `15ecf12a9d`, `54f299c9ba`
**Verdict:** Needs Work

## Summary

Three commits fix the chat's navigate-away-mid-stream data loss (2.1), make
the input non-blocking during streaming (2.2), collapse long tool-call runs
into a single-line `<details>` summary (2.3), and close the root-cause
`text-delta for missing text part` protocol bug by changing the StreamRegistry
overflow policy. The stream-registry fix and its tests are solid. The
playground-side changes have **one data-leakage bug (queued messages
cross-pollinating workspaces) and one UX regression (the tool-call drawer
forcibly collapses against user intent)** that should block merge.

## Critical

### C1. `queuedMessages` leaks across workspaces — `user-chat.svelte:281-302`

The `$effect(wsId)` resets `localEvents`, `initialMessages`, `error`, and
`rehydrationDone` when workspace changes, but **not** `queuedMessages`. Repro:
user types "summarize X" while workspace A is streaming → navigates to
workspace B → workspace B's chat becomes ready and non-streaming → the flush
effect fires `chat.sendMessage` with the queued parts. The prompt ends up
cross-posted to workspace B under B's Chat instance.

`switchToChat()` (`user-chat.svelte:665-677`) has the same hole.

This directly undermines the workspace boundary that commit `6d7ec481f2`
introduced.

**Fix:** reset `queuedMessages = []` inside the wsId effect and `switchToChat`.

### C2. `<details open={anyRunning}>` overrides user intent — `chat-message-list.svelte:329`

`<details>`'s `open` attribute is reactive and driven from state. When
`anyRunning` flips false, Svelte writes `open={false}` — **forcibly collapsing
the drawer even if the user manually expanded it mid-run**. Concretely: user
clicks to expand so they can watch individual tool cards; last tool finishes;
drawer slams shut; they lose scroll position and context.

The inline comment at `chat-message-list.svelte:321-327` treats the
auto-collapse as desirable, but it collides with manual control.

**Fix direction:** latch a `userToggled` flag on the `ontoggle` event and stop
driving `open` from state once the user has interacted.

### C3. Flush-effect reentrancy on rapid queued sends — `user-chat.svelte:390-396`

```ts
$effect(() => {
  if (streaming || queuedMessages.length === 0 || !chat) return;
  const next = queuedMessages[0];
  if (!next) return;
  queuedMessages = queuedMessages.slice(1);
  void chat.sendMessage({ role: "user", parts: next });
});
```

`chat.sendMessage` flips `status` to `submitted` on a microtask, not
synchronously. The effect tracks `streaming`, `queuedMessages`, and `chat`.
After `queuedMessages.slice(1)` writes, Svelte re-invalidates the effect. If
the AI SDK hasn't flipped `status` yet, the next pass sees `streaming === false`
with `queuedMessages.length > 0` and fires **another** `sendMessage` on the
same tick.

Result with 3 rapid queued messages: 2–3 POSTs can dispatch in the same tick,
racing on the same `chatId`. Manual verification ran with a single queued
message, so this didn't surface.

**Fix direction:** guard with a local `flushing` boolean, or move the flush
into a non-effect async function awaiting `sendMessage` before pulling the
next queue entry.

## Important

### I1. `switchToChat` races the wsId `$effect` — `user-chat.svelte:665-677`

Both paths write `chatId`, flip `rehydrationDone = false`, and schedule
`rehydrateChat().finally(() => rehydrationDone = true)`. If a chat-panel click
collides with a route change, two in-flight rehydrates resolve in arbitrary
order; the later `.finally` wins and could render messages from the earlier
chat under the current `chatId`.

**Worth doing:** Yes — guard with a monotonic token compared inside `.finally`.
Low cost, eliminates a latent race.

### I2. Rehydrate 404 still triggers `resumeStream` — `user-chat.svelte:223-227, 353-360`

On 404, `rehydrateChat` clears localStorage but leaves `chatId` set to the
deleted id; the resume effect then fires `GET /chat/<deletedId>/stream`. Today
it's harmless (registry returns 204), but we're advertising traffic for a chat
we know is gone and tying `shouldResumeStream` to a soon-to-be-replaced id.

**Worth doing:** Yes, small — on 404 reset `chatId = crypto.randomUUID()` and
`shouldResumeStream = false`.

### I3. `resumeStream()` leaks orphaned SSE connection on rapid wsId switch — `user-chat.svelte:353-360`

The resume effect kicks off `chat.resumeStream()`, which opens a GET to
`/stream`. If `wsId` changes while the fetch is still in flight, the old Chat
instance becomes unreferenced but the fetch keeps running until the server
hangs up. One orphaned HTTP request per rapid switch.

Not a correctness issue today (GC + server timeout eventually), but noticeable
under heavy navigation. **Worth doing:** No for now — thread an `AbortSignal`
if this surfaces in practice.

### I4. StreamRegistry memory ceiling — `stream-registry.ts:18-31`

50k events × ~500 B = ~25 MB per active chat before `replayDisabled` kicks in.
With STALE_TTL_MS=30min and a multi-tenant daemon, worst case is `N × 25 MB`.
100 concurrent chats = 2.5 GB resident just for stream buffers, vs. the old
~1 MB cap. For single-tenant local daemon this is fine; for a shared pod it's
a DoS vector (malicious client generates 50k chunks).

**Worth doing:** Yes, later — add a per-process total-events ceiling or a
smaller MAX when running under a tenanted deployment. Not urgent.

### I5. Playground has no tests for the new state logic — `user-chat.svelte`

New logic that was verified only manually:
- `shouldResumeStream` one-shot gate
- `queuedMessages` FIFO flush on `streaming` transition
- `wsId`-tracked state reset on workspace change
- Rehydrate-then-resume ordering

Project pattern (see `collapsible-state.test.ts`, `inspector-state.test.ts`,
`waterfall-layout.test.ts`) is to extract pure logic into `.ts` helpers and
unit-test them. The queue-flush reducer is the highest-value extraction —
`(queue, streaming, chat) → {toSend, remainder}` is pure and would eliminate
the C3 surface area. Everything else is thin enough to leave inline.

**Worth doing:** Yes on queue flush; No on the rest (playground is local-only
per CLAUDE.md).

## Tests

New `stream-registry.test.ts` cases correctly exercise the overflow policy:
non-eviction invariant, live-subscriber broadcast continues post-overflow, and
new-subscriber refusal. Mocks are minimal (`StreamController` stubs only); no
Vitest gotchas from CLAUDE.md apply.

### Test gaps

- **Boundary at exactly MAX_EVENTS.** The new test jumps from 0 →
  `MAX_EVENTS + 100`. No assertion that the Nth call is accepted and the
  (N+1)th trips `replayDisabled`. The guard at `stream-registry.ts:162` uses
  `>=` — a single boundary test pins this against a `>` regression.
  **Worth doing:** Yes — one short test.

- **Log-fires-once assertion.** The `stream_buffer_overflow_replay_disabled`
  warn is the only observability hook; the `!buffer.replayDisabled &&` guard
  ensures once-per-stream firing, but no test asserts it. A `vi.spyOn(logger,
  "warn")` with 50 100 appends would prove the invariant.
  **Worth doing:** Yes, small.

## Notes

- **N1.** `chat-list-panel.svelte:41` — `return parsed as Record<string,
  string>;` violates the CLAUDE.md "no `as` assertions" rule. Use
  `z.record(z.string(), z.string()).safeParse(parsed)`. Local blast radius
  (dev tool, localStorage parse only), but trivial to fix.

- **N2.** Chat-list `15s` polling continues while tab is hidden. Gate on
  `document.visibilityState === "visible"` to avoid useless daemon traffic.
  Low priority.

- **N3.** `LAST_OPENED_KEY` is global (`atlas:chat:lastOpened`) rather than
  per-workspace. Harmless (chatIds are UUIDs, can't collide), noted.

- **N4.** `COLLAPSE_THRESHOLD = 3` is a reasonable default. Consider
  `length ≥ 3 AND estimated-height > N` later so two large `run_code` blocks
  don't dominate the thread. Not urgent.

- **N5.** `stream-registry.ts` constructs `new TextEncoder()` per
  `appendEvent`. `DONE_CHUNK` is already cached; a class-level encoder would
  follow the same pattern. Microperf nit.

- **N6.** Memory footprint change (1k → 50k events) deserves a one-line note
  in the follow-up PR description or deploy notes. The old limit was silently
  corrupting replay, so 50k is unambiguously better — but it's a real
  working-set jump.

## Needs decision

1. **Block on C1+C2, or ship with C1+C2 as fast-follow?** C1 is a cross-
   workspace data leak (queued prompt from A posts to B); C2 is a UX
   regression on the 2.3 collapse feature. Both are small fixes (≈5 lines
   each) — recommend blocking merge until they land.

2. **MAX_EVENTS ceiling for multi-tenant.** Current 50k is safe for single-
   tenant local daemon. If Friday is deployed as a multi-tenant service, the
   ~25 MB-per-chat ceiling × N chats is worth capping. Author decision: scope
   this into a follow-up or adjust now?
