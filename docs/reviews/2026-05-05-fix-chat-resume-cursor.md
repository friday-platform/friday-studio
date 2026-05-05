---
name: Review fix-chat-resume-cursor
description: Code review for PR #197 — cursor-based SSE resume against Chrome's fetch streaming cap
type: review
---

# Review: fix-chat-resume-cursor

**Date:** 2026-05-05
**Branch:** fix-chat-resume-cursor
**PR:** https://github.com/friday-platform/friday-studio/pull/197
**Verdict:** Needs Work

## Summary

The fundamental approach — cursor-based SSE resume + open-parts re-emit + client cursor tracker — is sound and well-engineered. Server-side cursor logic is tightly tested; comments are unusually clear. Two real correctness gaps and one design choice that silently truncates long tool calls keep this from being mergeable as-is, and the entire client side of the fix (`trackingFetch`, resume-on-error effect) ships with zero tests despite housing the trickiest logic in the diff.

## Critical

### Resume budget never resets on forward progress — silently truncates long tool calls

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:147,517-522,1147-1148`

**Problem:** `MAX_TURN_RESUMES = 20` only resets in `submit()`. Each Chrome ~50s cap consumes one attempt, even when the resume succeeded and N additional events streamed cleanly. A 25-minute tool call across 50s windows needs ~30 attempts and dies on the 21st with no signal beyond the banner — exactly the failure mode the PR is trying to eliminate, just at a longer timescale. The PR's own comment ("2-min tool call needs ≥3 resumes") tacitly assumes turns stay under ~17 minutes.

**Recommendation:** Reset (or significantly decrement) `resumeAttempts` whenever `lastSeenEventId` has advanced since the last failure — the budget should guard against tight loops on a stuck server, not legitimate long turns. Track `lastSeenEventIdAtLastFailure`; if current is higher, reset the counter.

**Worth doing:** Yes — this is the exact user-facing failure mode the PR exists to fix, just at a longer time scale. Low-cost change.

### Cursor-commit race in `trackingFetch` is completely untested

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:184-238`

**Problem:** The most subtle bug fix in the diff — `pendingId` only promotes to `lastSeenEventId` on the empty-line SSE terminator, not on the `id:` line — has zero tests. The author's own 9-line comment documents the failure mode: commit too early and a chunk-boundary drop between `id: N\n` and `data:`/terminator advances the cursor past an event the AI SDK never received → server skips it on resume → "tool-input-delta for missing tool call" → resume → loop. This is the riskiest code in the PR.

**Recommendation:** Extract the TransformStream factory to a standalone module (e.g. `cursor-tracking-fetch.ts`) and unit-test with hand-chunked SSE byte streams covering: (a) commit-on-terminator, (b) chunk split between `id:` line and `data:` line, (c) chunk split mid-`id:` line, (d) replay-disabled stream with no `id:` lines, (e) cursor monotonicity (lower id must not regress).

**Worth doing:** Yes — 30 minutes of work to protect the highest-risk code in the PR.

### Resume-on-error effect with 20-attempt budget is untested

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:506-524`

**Problem:** The orchestration that delivers the user-facing benefit has no test. Silent regressions waiting to happen: budget off-by-one, forgetting `clearError()` before `resumeStream()`, accidentally resuming on a `data-error` chunk (double-bubbled banner), `resumeAttempts` not incrementing on synchronous throws, reset-on-new-turn breaking.

**Recommendation:** Either extract this state machine to a `resume-controller.svelte.ts` with `chat` injected and unit-test budget exhaustion + skip-on-data-error + reset-on-new-turn, or use a Svelte component test with `vitest-browser-svelte` that mounts `<UserChat>` against a mock `Chat`.

**Worth doing:** Yes — pairs with the budget-reset fix above; without tests the fix is one refactor away from regressing.

## Important

### `tool-input-available` past the cursor is silently dropped on resume

**Location:** `apps/atlasd/src/stream-registry.ts:79-93` (`partKey`), `336-422` (`subscribe`)

**Problem:** `partKey` only treats `tool-input-start` as opening and `tool-output-available`/`tool-output-error` as closing. The intermediate `tool-input-available` chunk — which the AI SDK emits when input is fully formed — is neither tracked nor re-emitted. If the cursor lands between `tool-input-available` and `tool-output-available`, the resumed stream gives the SDK only `tool-input-start` plus `tool-output-available`, having silently swallowed `tool-input-available`. Whether that trips a validator depends on the SDK version; this is exactly the class of bug the PR is meant to prevent.

**Recommendation:** Either explicitly track `tool-input-available` in `partKey` so the open-parts re-emit guarantees the SDK has the input registration, or add a test that proves the SDK tolerates its absence on this transport. Apply the same scrutiny to `step-start`.

**Worth doing:** Yes — this PR is the right place to address all related lifecycle chunks; cost is small.

### Replay-disabled buffer + cursored resume → 200 OK with empty body (silent truncation)

**Location:** `apps/atlasd/routes/workspaces/chat.ts:159-185`

**Problem:** When `subscribe()` returns false because `buffer.replayDisabled === true`, the route has already committed `200 OK` headers via the `ReadableStream`. The controller closes immediately, producing an empty `text/event-stream`. The AI SDK reads zero events and treats the stream as cleanly finished — no error fires, the resume effect doesn't retry, the user's mid-turn assistant message is silently truncated. Pre-existing issue, but the PR amplifies its likelihood by making resume aggressive.

**Recommendation:** Check `buffer.replayDisabled` before constructing the ReadableStream; return 204 (or a 4xx with `X-Stream-Replay-Disabled: true`) so the client can surface a real error.

**Worth doing:** Yes — same code path the PR is overhauling and the fix is one early-return.

### Server: `reasoning-end` and `tool-output-error` close paths untested

**Location:** `apps/atlasd/src/stream-registry.test.ts` ("forgets parts once their close event is recorded" only covers `text-end` and `tool-output-available`)

**Problem:** `partKey` (stream-registry.ts:79-93) handles 6 chunk types. Tests exercise only 4. `reasoning-end` and `tool-output-error` are wired but never asserted to remove from `openParts`. A typo in `partKey` ships unnoticed.

**Recommendation:** Parameterize the existing test with `test.each` over the three close types, or add two short tests for `reasoning-end` and `tool-output-error`. ~5 lines each.

**Worth doing:** Yes — cheap and closes a real coverage hole.

### Null-body status guard (204) and Last-Event-ID URL gating untested

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:201-204` (null-body), `163-168` (URL gating)

**Problem:** The 204 guard prevents `new Response(stream, {status: 204})` from throwing — and the resume endpoint returns 204 when the chat has finished, so this fires on the "user reopens a finished chat" path. The `endsWith("/stream")` URL check gates whether `Last-Event-ID` injects on the request; a future endpoint named `/stream` or a method-based check would silently regress.

**Recommendation:** Once the fetch wrapper is extracted, three tests: 204 → unwrapped Response, GET `/stream` with cursor → header present, POST same URL → header absent.

**Worth doing:** Yes — bundles cheaply with the cursor-commit extraction.

### `NULL_BODY_STATUS` allocated per fetch call

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:201`

**Problem:** Speculative-generality micro-issue. The fetch spec's null-body status set is fixed; allocating a new `Set` on each fetch is wasteful and obscures that 204 is the only one the resume endpoint actually returns.

**Recommendation:** Hoist to a module-level `const`, or just check `response.status === 204` since that's the only status the resume contract produces with a null body.

**Worth doing:** Yes — one-line cleanup.

### SSE line-terminator handling assumes LF-only

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:211-235`

**Problem:** The parser only splits on `\n` and compares `line === ""`. SSE per WHATWG accepts `\r`, `\n`, or `\r\n`. If any proxy/transport CRLF-normalizes, the trailing `\r` makes `line === ""` never match and the cursor never advances.

**Recommendation:** Strip a trailing `\r`, or split on `/\r\n|\r|\n/`.

**Worth doing:** Yes — cheap robustness against future infrastructure changes.

### `test.each` #3 self-contradicting — title says "ignores invalid" but `"1.5"` is accepted

**Location:** `apps/atlasd/routes/workspaces/chat.test.ts:296-321`

**Problem:** The parameterized test is titled "ignores invalid Last-Event-ID" but the third row (`"1.5"`) asserts the OPPOSITE — that it's accepted as `1`. The branch inside the test makes it self-contradicting. The "documentation" comment papers over it. If a future reader tightens the parser to reject fractional headers, this test passes incorrectly because the assertion is keyed on the literal string.

**Recommendation:** Split into two tests: one `test.each` for actually-rejected inputs (`"abc"`, `"-1"`, `""`, `" "`), and a separate test documenting `"1.5"` parsing as `1` with the rationale.

**Worth doing:** Yes — small cost, clearer intent.

### Mock ratio in chat.test.ts new tests is high

**Location:** `apps/atlasd/routes/workspaces/chat.test.ts:275-321`

**Problem:** These tests are 90% mock setup to assert "the route forwards a header parameter to a mock function." The parsing logic itself isn't isolated for direct testing.

**Recommendation:** Keep one integration test that proves `Last-Event-ID` flows through to `subscribe`'s 3rd arg. Extract the parser to a helper (`parseLastEventIdHeader(header: string | undefined): number | undefined`) and unit-test edge cases there cheaply (`""`, whitespace, `"NaN"`, very large, `"4.9e10"`).

**Worth doing:** Yes — but lower priority than the missing client tests.

### Re-emit ordering comment slightly misleading

**Location:** `apps/atlasd/src/stream-registry.ts:380-384`

**Problem:** Comment claims insertion order alone would suffice and the explicit sort is a "safety belt." Actually the sort is load-bearing for `delete`-then-`set` keys (a tool reusing a `toolCallId` after completion would land at the end of insertion order, not its original position).

**Recommendation:** Drop the "safety belt" framing or document the deleted-then-reinserted case explicitly.

**Worth doing:** Yes — one comment edit.

### Initial-turn rehydrate `resumeStream()` doesn't initialize cursor

**Location:** `tools/agent-playground/src/lib/components/chat/user-chat.svelte:467-490`

**Problem:** Pre-existing rehydrate-time `resumeStream()` doesn't set `lastSeenEventId` — sends no `Last-Event-ID`, gets full replay, re-renders all events on top of the persisted partial assistant message → duplicates. Not introduced by this PR, but the PR's own analysis applies.

**Recommendation:** Out of scope. Either flag as known limitation or follow up by extracting a "last frame id" from rehydrated messages or asking the server for a turn-start cursor.

**Worth doing:** No — pre-existing, not the author's mess to clean up here. Track separately.

## Tests

Server-side tests are solid: real `StreamRegistry` (no mocks for the unit under test), assertions on actual SSE wire bytes via `TextDecoder`, good cursor-math coverage (clamp, past-tail, at-tail, re-emit-open-parts, no-re-emit-on-full-replay, forget-on-close, overflow-omit-id). The "does not re-emit `*-start` when no cursor is given" test is the right kind of regression test.

Client side has zero tests despite housing the riskiest logic in the PR (cursor-commit race, resume budget, null-body guard, URL gating). See Critical section.

## Needs Decision

1. **Scope of `partKey` lifecycle coverage.** Does this PR also handle `tool-input-available`, `step-start`, and any other intermediate AI SDK chunks that mutate active-state, or does it stay narrow on the original `*-start`/`*-end`/`*-output-*` six? Narrow scope is defensible if there's evidence the SDK validator only fires on `tool-input-delta` and `text-delta`.

2. **Refactor for client testability.** Extracting `trackingFetch` and the resume effect adds two new files but unlocks all the missing client tests at once. Worth it now, or merge as-is and follow up?
