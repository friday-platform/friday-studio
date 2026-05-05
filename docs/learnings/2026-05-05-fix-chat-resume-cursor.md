# Team lead learnings — fix-chat-resume-cursor (PR #197 follow-ups)

Wave 1: Tasks 1, 3, 4 in parallel (Po=4 heavy, Luka=1 light, Almond=3 medium).
Wave 2: Tasks 2, 5 in parallel after #4 lands (Storm=2, Ferox=5).

## Wave 1 outcomes (all approved first-attempt)

- **Luka → Task 1** (commit 625b7e7): replay-disabled buffers now return 410 + `X-Stream-Replay-Disabled` header. Surgical 12-line guard before the ReadableStream construction. 25/25 tests pass.
- **Almond → Task 3** (commit a6b4234): `tool-input-available` added as opener under same `tool:<id>` key — single-key overwrite semantics in `appendEvent.set()` mean re-emit picks the latest state-bearing chunk. Closed two pre-existing close-path test holes (`reasoning-end`, `tool-output-error`) and pinned the `start-step`/`finish-step` non-tracking decision with a regression test. 49/49 tests pass.
- **Po → Task 4** (commit ab6c98e): extracted `trackingFetch` to `cursor-tracking-fetch.ts` parameterised by `getCursor`/`setCursor`/`isResumeRequest` callbacks. 16 unit tests including CRLF terminators (preempted Task 5 scope cleanly). 0 svelte-check errors.

## Task 5 superseded

Po's CRLF handling at `cursor-tracking-fetch.ts:120` (`if (line.endsWith("\r")) line = line.slice(0, -1);`) plus the CRLF terminator test at `cursor-tracking-fetch.test.ts:162-165` covers the failure mode the review actually flagged (CRLF-normalizing proxies). Bare-CR-only line endings remain unsupported but that's an irrelevant edge case in modern HTTP infrastructure. Marking Task 5 superseded saves a teammate spawn.

## Notable codebase quirks observed

- AI SDK v6 wire chunk types are `start-step`/`finish-step` — NOT `step-start`/`step-end`. The latter pair is the message-PART type emitted into `message.parts`, not a chunk on the SSE wire. Easy to mix up; bit me when writing the original review.
- `tool-input-available` can arrive without a preceding `tool-input-start` (non-streaming-input path). Single-`-start` model in resume bookkeeping must accommodate this.
- Vitest `TransformStream` tests deadlock if you await `reader.read()` one-shot per write without a parallel drain — the writer's backpressure won't release until something pulls. Background drain loop is the reliable shape (Po's pattern).
- `subscribe()` returning false from inside a `ReadableStream.start()` is a silent failure — the response status is already committed by `c.body()` before `start()` runs, so the only "error signal" is an empty body. Any future failure mode in `subscribe()` needs to be intercepted at the route layer before `c.body()` returns.

## Wave 2 outcomes

- **Luka → Task 2** (commit 1633be0): extracted budget logic to `resume-budget.ts` as a pure reducer mirroring the `chat-queue.ts` and `cursor-tracking-fetch.ts` patterns. 9 tests cover the four real states (first-failure, no-progress, forward-progress, exhausted-but-rescued). The "exhausted-but-rescued" case (`resumeAttempts >= MAX` AND forward progress arrives at next failure) wasn't in my original Task 2 spec — Luka caught it as a fourth case worth explicit handling. Right call.
- Task 5 superseded by Po's CRLF coverage in Task 4. Ferox not spawned, saved one spawn cycle.

## Session-level observations

- **Pattern emergence in one session**: `chat-queue.ts` already existed as a pure-reducer pattern. Po introduced `cursor-tracking-fetch.ts` (CursorState callback shape) and Luka introduced `resume-budget.ts` (input/output reducer). All three follow the same idea: pure logic in `.ts` siblings, mutable Svelte runes stay in `.svelte`. Worth landing in CLAUDE.md as the documented pattern for testable client-side logic.
- **All 4 tasks landed first-attempt, 0 rejections.** Self-contained task descriptions with full code blocks, line numbers, and test patterns paid off — no teammate had to ask clarifying questions about the brief.
- **Wave sequencing was conservative**: Task 4 and Task 2 both edit `user-chat.svelte` but in disjoint regions. I sequenced them defensively (Wave 1 vs Wave 2) to avoid merge risk. Parallel would have worked given the file's size and the disjoint edit regions — but the cost of sequencing was low.
- **Teammate misunderstanding once**: Luka responded to my "claim Task 2" assignment by reporting Task 4 was already complete. They needed a second, more direct go-ahead. Watch for: when a teammate is wrapping up Task N and you message about Task N+1, they may interpret the message in Task N's frame. Be explicit: "Claim Task 2 now."

## Final state

- 4 commits landed on `fix-chat-resume-cursor`: 625b7e7, a6b4234, ab6c98e, 1633be0
- 204/204 tests pass on changed files
- 0 svelte-check errors, 0 deno check errors
- 4 of the original 5 review-derived tasks completed; #5 superseded

## Pre-existing test failures (NOT from this session)

`apps/atlasd/daemon-startup.test.ts` (3) and `apps/atlasd/src/chat-sdk/atlas-web-adapter.test.ts` (1) fail at the base commit (d55656f) too. Worth a separate fix task, not blocking this PR.
