---
date: 2026-05-05
branch: main (worktree: cuddly-spinning-whisper)
verdict: Needs Work
---

# Review: retrieval-gated-injection

**Date:** 2026-05-05
**Branch:** main (worktree cuddly-spinning-whisper, ~50 commits ahead)
**Verdict:** Needs Work

## Summary

Phases 0–4 + partial Phase 6 of the retrieval-gated-injection plan: USERS
JetStream KV bucket, nanoid local user id, identity auto-sync, cross-workspace
identity unification, four new workspace-chat tools (describe_workspace,
describe_skill, list_integrations, set_user_identity), in-memory Block 2 cache,
and prompt.txt restructuring with adversarial-review fixes. Architecture and
correctness are sound — no critical blockers — but several plan-claimed
behaviors are aspirational rather than implemented (cache breakpoints, Phase 6
adoption gate), and test coverage has gaps in the most security-relevant new
code.

## Critical

None.

## Important

### 1. Cache breakpoints are not configured on `streamText`

**Where:** `packages/system/agents/workspace-chat/workspace-chat.agent.ts:790-885`

The plan and prompt.txt structuring claim a 4-block cache layout (Block 1
weeks-stable / Block 2 workspace-stable / Block 3 session-stable / Block 4
turn-local) targeting Anthropic's `cacheControl: ephemeral` breakpoints. The
implementation produces the right textual layout, but `streamText` is invoked
without any `cacheControl` configuration — so what ships is a single byte-stable
prefix that the provider may or may not cache, not four explicit breakpoints.

**Recommendation:** Either wire `providerOptions.anthropic.cacheControl` per
block, or update the plan to say "the *layout* is cache-friendly; explicit
breakpoints deferred." Don't leave the gap silent.

**Worth doing:** Yes — the whole point of the restructure was provider cache
hits. Without breakpoints, this is layout cosmetics. Fix: ~30 lines in
`workspace-chat.agent.ts`. Cost of skipping: prompt cache savings claimed in
the plan don't materialize.

### 2. Missing `list_integrations` adoption eval

**Where:** `tools/evals/agents/workspace-chat/prompt-behavior.eval.ts`

The Phase 6 plan explicitly gates inlined-integration removal on adoption
behavior — i.e., when a user mentions a connected integration, the model should
call `list_integrations` (or `describe_workspace`) before answering. The eval
suite covers voice, no-fabrication, memory-save, and describe-skill; it does
**not** cover this gate. Without the eval, regressions in adoption land
silently.

**Recommendation:** Add a case where the user mentions Slack / Drive /
Calendar with an unconnected integration and assert the model calls
`list_integrations` rather than fabricating capability.

**Worth doing:** Yes. The plan calls this out as a gate; shipping Phase 6
without it means we can't tell if the model is using the new tools. ~40 lines.

### 3. Missing unit tests for `set-user-identity.ts` and `describe-skill.ts`

**Where:** `packages/system/agents/workspace-chat/tools/`

`set-user-identity.ts` is a security boundary — userId is closure-captured at
factory time so a model can't smuggle a different identity. There is no test
asserting that. `describe-skill.ts` has workspace-scope filtering via
`resolveVisibleSkills` and no test.

**Recommendation:** Add `set-user-identity.test.ts` covering: closure binding,
exactly-one-of `{name}` or `{declined: true}` refinement, USERS write
side-effect. Add `describe-skill.test.ts` covering visibility filtering and
the metadata-without-body shape.

**Worth doing:** Yes for `set-user-identity` (security). Yes for
`describe-skill` (scope filter is the load-bearing behavior).

### 4. Block 4 preface as synthetic `messages[0]` may break replay/UI

**Where:** `packages/system/agents/workspace-chat/workspace-chat.agent.ts`

The Block 4 preface (memory + datetime) is constructed per-turn and injected
as the first user message. Any UI/replay path that assumes `messages[0]` is
the originating user message — including Chat SDK persistence and SSE replay
— sees the preface instead. Manual QA earlier in the session didn't surface
breakage, but there's no test pinning this behavior.

**Recommendation:** Add a test that posts a message and asserts the persisted
`messages[]` (via `ChatStorage.getChat`) doesn't contain the preface as a user
message. Either filter out preface on persist, or move the preface into the
system prompt.

**Worth doing:** Yes. This is a load-bearing convention break with no test.
Risk is real even if invisible today. ~30 lines test + maybe a filter in
`atlas-web-adapter.ts`.

### 5. Block 2 cache is unbounded

**Where:** `packages/system/agents/workspace-chat/block2-cache.ts`

In-memory `Map` keyed by workspaceId, no eviction beyond TTL expiry on read.
A long-lived daemon with N workspaces accumulates N entries forever, even if
those workspaces are inactive. TTL only applies on get-with-expired-entry —
expired entries that are never re-read leak.

**Recommendation:** Add an LRU cap (e.g., 64 entries) or a periodic sweep.
This is "deferred from in-memory v0" in the plan; either implement now or
note in the plan that v0 leaks under multi-workspace load.

**Worth doing:** Yes for daemon, but small. ~20 lines for an LRU. Cost of
skipping in a single-tenant local daemon: negligible. Cost in any deployed
multi-workspace daemon: unbounded memory growth.

### 6. Onboarding gate drift from plan

**Where:** `packages/system/agents/workspace-chat/onboarding.ts`

The plan specifies onboarding completion is gated on
`onboarding.completedAt + onboarding.version`. The implementation gates on
`identity.nameStatus !== "unknown"`. These usually align but diverge for any
user who declined naming (`nameStatus: "declined"`, no `completedAt`) — those
users will be re-onboarded if the version bumps.

**Recommendation:** Either change the gate to read `completedAt + version`
(matching the plan), or document why `nameStatus` is the actual gate and
delete the plan's `completedAt + version` line. They can't both be true.

**Worth doing:** Yes — it's a 1-line gate, and version-bump
re-onboarding semantics are a stated design property.

### 7. `clearBlock2CacheForTests` exported from production code

**Where:** `packages/system/agents/workspace-chat/block2-cache.ts`

A test-only export on production code violates the
"production code doesn't know about tests" iron-law. It's also imported by
`block2-cache.test.ts` directly, which couples test infrastructure to a
specific singleton-Map shape.

**Recommendation:** Refactor the cache to be passed in via constructor /
factory parameter so tests can use a fresh instance. Failing that, gate the
export behind a build flag. Failing that, document why it's pragmatic.

**Worth doing:** Lower priority than the others. The test contamination
problem is real but the blast radius is contained. Worth a follow-up.

### 8. `resolveLocalUserId` race / orphans

**Where:** `packages/core/src/users/jetstream-backend.ts`

CAS retry loop is correct, but two daemon starts before the `_local` pointer
is written can each generate a nanoid and create a USERS entry — only one
wins the CAS, the other is orphaned in USERS. Probability is low (window is
small) but not zero.

**Recommendation:** Either accept (and document), or write the user record
*after* CAS success on `_local`. Today the order is: generate id → write
USERS entry → CAS `_local` pointer. Inverting (CAS pointer first, then
write entry) eliminates the orphan but means the pointer briefly references
a missing record.

**Worth doing:** Lower priority. Single-tenant local daemon → cold-start
race window is tiny. Document, follow-up if it ever bites.

## Tests

### Solid

- `packages/core/src/users/storage.test.ts` — real NATS via `startNatsTestServer`, 7 cases covering init/get/ensure/setIdentity/markOnboarding/resolveLocal
- `packages/system/agents/workspace-chat/tools/envelope.test.ts` — schema + provenance shape
- `packages/system/agents/workspace-chat/tools/list-integrations.test.ts` — status filtering
- `packages/system/agents/workspace-chat/onboarding.test.ts` — gate behavior
- `apps/atlasd/src/chat-sdk/atlas-web-adapter.test.ts` — webhook validation, prompt-injection guards (assistant/system role 403), SSE streaming

### Gaps

- **No test for either new migration** — `m_20260504_025000_provision_users_bucket.ts` and `m_20260504_025500_rekey_default_user_chats.ts`. The rekey migration shipped *with* a silent data-loss bug (iterator pattern collected keys lazily) that took manual QA to find. A test that seeded N legacy entries and asserted N rekeyed entries would have caught it.
- **No `set-user-identity.test.ts`** — see Important #3
- **No `describe-skill.test.ts`** — see Important #3
- **No test for the auto-sync IIFE** in `user-identity.ts` — the conditional logic (`!userRecordExists || nameStatus === "unknown"`) was explicitly broken once and silently reverted-able

### Fragile

- `block2-cache.test.ts` — fake-timer ordering coupled to implementation
- `describe-workspace.test.ts` — five queued `mockResolvedValueOnce` slots; reorder breaks all
- `user-profile.test.ts` — mostly tests the mock surface

### Eval framework concerns

- `prompt-behavior.eval.ts` uses `dotenv.config()` instead of the in-tree `loadCredentials()` convention — should be aligned
- `describe-skill/applicability-check` `expectedDescribed` list is too lenient (passes if model calls describe_skill for *any* of the listed skills, not the right one)
- Voice case is subjective and the LLM judge may flake — consider tightening the rubric or splitting into two cases (positive + negative example)

## Needs Decision

1. **Phase 6 partial — ship or finish?** Inlined-integration removal is
   half-done: only `status="ready"` are inlined, with a `<note>` pointing at
   `list_integrations`. Plan still lists workspace XML, user_identity, and
   artifact summaries as inlined. Decision: ship the partial as a milestone
   (and update the plan), or finish before merge?

2. **Cache breakpoints — implement now or defer?** See Important #1. If
   deferred, the plan's "4 cache breakpoints" claim should be downgraded to
   "4 logical sections."

3. **`completedAt + version` vs `nameStatus` gate** — see Important #6.
   Two valid designs; pick one.

4. **Migration tests — backfill before merge?** No tests for two migrations
   that touched real production data. The rekey migration shipped with a
   bug. Adding tests now is cheap insurance against the next migration.

---

## Top 3 to fix before merge

1. Add `list_integrations` adoption eval (Phase 6 gate from plan).
2. Add `set-user-identity.test.ts` (security boundary, no test today).
3. Decide on cache breakpoints — either wire them or update the plan.
