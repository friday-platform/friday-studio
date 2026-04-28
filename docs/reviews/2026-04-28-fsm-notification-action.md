# Review: fsm-notification-action

**Date:** 2026-04-28
**Branch:** main (uncommitted)
**Verdict:** Needs Work

## Summary

Adds a `notification` FSM action type that lets workspace.yml authors broadcast a chat message as a step, reusing `ChatSdkNotifier` + `broadcastDestinations` + `broadcastJobOutput`. The discriminated-union extension, dependency-inversion via `FSMBroadcastNotifier`, and lazy chat-SDK construction via `getInstance` callback are all the right shape — but the 54-line adapter that holds all the non-trivial logic ships with zero coverage, and the four engine tests are all mock-on-mock for a 5-line dispatcher case. There's also a real silent-drop bug in the communicator filter and a small observability gap.

## Critical

### Adapter ships untested
**Location:** `apps/atlasd/src/chat-sdk/fsm-broadcast-adapter.ts:24-53` (no `*.test.ts`)

`createFSMBroadcastNotifier` owns four behaviors that nothing exercises: lazy instance resolution, allowlist filtering via `Object.entries(...).filter(...)`, the zero-destination diagnostic message operators will read in logs, and the `sourceCommunicator: null` invariant. The 5-line dispatcher case in `fsm-engine.ts` has four tests; the 54-line adapter has none — Pareto inverted.

**Recommendation:** Add `apps/atlasd/src/chat-sdk/fsm-broadcast-adapter.test.ts` mirroring `broadcast.test.ts` style (real `ChatSdkNotifier` + `makeMockAdapter` + stub `getInstance`). Cover: communicators filter excludes non-listed kinds; missing communicators throws with `requested=` text; omitted communicators broadcasts to all configured; `getInstance` rejection propagates; `sourceCommunicator: null` is forwarded.

**Worth doing: Yes** — the existing test infra (`__test-utils__/mock-adapter.ts`, the broadcast.test.ts pattern) is right there; ~30-min addition; closes the gap that the silent-drop bug below exists *because* nothing tests this layer.

## Important

### Silent-drop: unknown communicators in allowlist don't throw
**Location:** `apps/atlasd/src/chat-sdk/fsm-broadcast-adapter.ts:30-43`

The filter is set-intersection. `communicators: ["slack", "telegram"]` against a workspace with only telegram configured produces `{telegram: ...}` — non-empty, no throw, slack silently dropped. Typos behave the same: `["slack", "slak"]` on a slack-only workspace doesn't throw. The throw only fires when intersection is empty.

**Recommendation:** Compute the set difference `requested - configured` and throw if non-empty (every requested kind must exist). Matches the engine's existing fail-loud stance for missing notifier.

**Worth doing: Yes** — real bug, not theoretical; one-line fix; the alternative is "configured a notification, got nothing, no error" — exactly the failure mode that erodes trust in declarative config.

### Dispatcher error message points at the wrong audience
**Location:** `packages/fsm-engine/fsm-engine.ts:1582-1589`

Error tells the YAML author "Configure at least one chat communicator with a default_destination in workspace.yml." But this branch fires when `FSMEngineOptions.broadcastNotifier` is missing — an engine-host wiring problem (atlasd or third-party consumer), not a workspace.yml problem. atlasd always wires the broadcaster, so the message lands at users who can't fix it from the file it names. The "no destinations" failure surfaces from `fsm-broadcast-adapter.ts:36-43` with its own (correct) message.

**Recommendation:** Reword: "FSMEngineOptions.broadcastNotifier is required for notification actions. Engine host must wire one (atlasd does this automatically; third-party consumers must construct their own)."

**Worth doing: Yes** — wording-only; ~30 sec; matters when this fires for someone embedding fsm-engine outside atlasd.

### `getActionId` returns undefined → notification spans/events have no id
**Location:** `packages/fsm-engine/fsm-engine.ts:1667-1668`

Returns `undefined` for notifications, so `fsm.action.id` OTel attribute is omitted (gated at `fsm-engine.ts:1042-1044`) and `FSMActionExecutionEvent.actionId` is undefined. Workspaces with multiple notification actions across states (the actual use case) can't distinguish them in traces or session-history. Every other action type returns a meaningful id (`agentId`, `event`, `outputTo`).

**Recommendation:** Return the same truncated message preview the filmstrip already computes (`entry-actions.ts:111-118`): `case "notification": return action.message.slice(0, 40);`. Cheap, traces become actionable, matches what users see in UI.

**Worth doing: Yes** — one-line fix; real observability win for the exact use case the feature is built for.

### Mock-on-mock test pattern
**Location:** `packages/fsm-engine/tests/notification-action.test.ts:29-45,47-65`

Tests #1 and #2 substitute `vi.fn<FSMBroadcastNotifier["broadcast"]>()` and verify the engine called `broadcast({ message, communicators })` with values pulled from the action object. Functionally `assert(action.message === args.message)` — two tests for one trivial pass-through. The interface is one we defined; mocking it tests our own boundary.

**Recommendation:** Collapse #1 and #2 into a single `test.each` table case; invest the freed bandwidth in the adapter integration tests (Critical above).

**Worth doing: Yes** — cleanup pairs naturally with writing the adapter tests; net less test code, more behavior covered.

### Dead branch in data-contracts.ts
**Location:** `packages/config/src/data-contracts.ts:75-81`

The added `producerAction.type === "notification"` check is unreachable. `producerAction` is found by `find((a) => (a.type === "agent" || a.type === "llm") && a.outputType)` — already structurally narrowed to `AgentAction | LLMAction`. The pre-existing `=== "emit"` check is dead too; this PR doubles the noise.

**Recommendation:** Replace the whole guard with `if (!producerAction) continue;` — delete both impossible branches in the same change.

**Worth doing: Yes** — TypeScript was satisfied because the `find` predicate doesn't narrow the return type at the value level, but the check is logically impossible. Cleanup is net negative LOC.

### Coverage gap: `getActionId` notification branch + telemetry path
**Location:** `packages/fsm-engine/fsm-engine.ts:1667-1668` (untested)

If the actionId fix above is applied (return `action.message.slice(0, 40)`), there's no guardrail against a future contributor returning `action.message` unbounded — silently exfiltrating full message bodies into OTel spans and the session-history feed. Even without the fix, returning the wrong thing wouldn't fail any test.

**Recommendation:** When you wire the actionId fix, capture `data-fsm-action-execution` events via `signal._context.onEvent` in one test and assert `actionType === "notification"` and that `actionId` is truncated (≤40 chars) or absent.

**Worth doing: Yes** — one assertion lock-in; protects against a real-shaped future regression.

### Coverage gap: schema parsing path untested
**Location:** `packages/fsm-engine/schema.ts:172-182`

Tests construct `FSMDefinition` objects directly in TS, bypassing `FSMDefinitionSchema.parse`. The discriminated-union wiring at line 183 is untested end-to-end — if `NotificationActionSchema` is forgotten in the union or a parent schema's discriminator gets out of sync, the workspace.yml → engine pipeline silently fails for notification actions.

**Recommendation:** Add `expect(FSMDefinitionSchema.parse(makeFSM())).toBeDefined()` before the engine instantiation in test #1, or extend an existing schema-parse test in `tests/` with a notification case.

**Worth doing: Yes** — one line; protects the union assembly (which is YOUR code, not Zod's).

## Tests

Four tests added (`notification-action.test.ts`); all pass. They protect the dispatcher case existence and the broadcaster-call argument shape, but at 100% mock ratio against a self-defined interface and with the real implementation (the adapter) untested. See Critical and the test-related Important findings above. Net: passing CI is misleading about real coverage.

## Needs Decision

1. **`message: z.string().min(1)` on `NotificationActionSchema`** — currently empty messages parse fine, run, and broadcast empty markdown to every channel. Schema-layer fix is one chained call. Worth it? Most chat APIs reject empty messages anyway, but the failure surfaces in adapter logs not in workspace validation.

2. **Boot-time validation for notification destinations.** Currently a workspace with `notification` actions but no chat communicators throws on every fire (and pays full chat-SDK construction cost since the cache is invalidated on throw). Alternative: extend `validateFSMStructure` (or a workspace-level check) to detect notification actions and verify the workspace has at least one configured destination at boot. Move the failure to "config error caught early" instead of "runtime error caught per fire."

3. **Move `CHAT_PROVIDERS` to a shared leaf package** so `NotificationActionSchema.communicators` can be `z.enum(CHAT_PROVIDERS)` instead of `z.array(z.string())`. Currently the list is hardcoded in three places (`adapter-factory.ts`, `chat-sdk-instance.ts:105`, and implicit in this PR). Bigger refactor than this PR — but if you defer, the silent-drop fix above becomes the only guard.

4. **Tighten `FSMBroadcastNotifier` JSDoc.** Current wording implies the interface exists for hypothetical future engine hosts. The real reason is dependency direction (fsm-engine is a leaf, can't import atlasd). Worth saying so explicitly so readers don't infer speculative generality.

5. **Unrelated hunks in the diff** — `apps/atlasd/routes/cron.ts` and `apps/atlasd/types.ts` were already reverted, but check `entry-actions.test.ts` for an existing notification-mapping test gap if you want filmstrip parity coverage.
