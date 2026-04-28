# Review: declaw — ChatSdkNotifier + broadcast hook

**Date:** 2026-04-27
**Branch:** declaw
**Verdict:** Clean (after follow-up fixes — see "Resolution" below)

## Summary

Implements `ChatSdkNotifier` per `docs/plans/2026-04-27-chatsdk-notifier-design.v3.md` (Tasks #1–#5) plus a broadcast-on-session-completion layer (`onSessionComplete` hook + `broadcastJobOutput` + `default_destination` on per-platform schemas + `user:<id>` openDM resolution + source-skip semantics). Original review surfaced 1 latent bug (openDM unguarded), real test gaps in the broadcast layer, and a documentation drift from v3. All addressed in the same commit.

## Resolution (post-fix)

Findings below were addressed before the squash. Each line marks the original severity and the fix.

- **C1 [Critical]** — `notifier.openDM()` now type-narrows the optional adapter method and throws a typed error when missing (`chat-sdk-notifier.ts:90-114`). Tested in `chat-sdk-notifier.test.ts` ("throws a typed Error when the adapter doesn't implement openDM").
- **C2 [Critical]** — Source identification uses the streamId prefix (`atlas-daemon.ts:1158-1170`). Chat thread IDs are canonically `<platform>:<channel>:<thread>` per the chat-SDK convention — the prefix IS the source platform, both for direct chat-platform inbounds and for nested job sessions invoked via the chat agent's job-tools (which inherit the parent chat's streamId). Earlier draft also stamped an explicit `signal.data.sourceCommunicator` at the inbound edge; that was removed during simplification because it returned the same value as the prefix in every case and added a redundant code path.
- **I1 [Important]** — `extractTextFromAgentOutput` exported and unit-tested in `runtime-extract-text.test.ts` (9 cases covering priority order, `data.<key>` fallback, top-level wins, JSON-stringify fallback, primitive coercion, circular ref).
- **I2 [Important]** — `broadcastJobOutput` covered by `broadcast.test.ts` (8 cases: full broadcast, source-skip, missing destination, threadId pass-through, raw channel formatting, openDM failure isolation, postMessage failure isolation, no-deliverable no-op). Shared `makeMockAdapter` lifted to `__test-utils__/mock-adapter.ts`.
- **I4 [Important]** — Added `workspaceHasBroadcastDestination` pre-flight in the daemon hook (`atlas-daemon.ts:114-145`) — workspaces with no chat config skip chat-SDK construction entirely. Falls through to lazy init on config-lookup error so legitimate broadcasts aren't dropped.
- **I5 [Important]** — Comment expanded on the `outboundDeliverable: false` marker site (`atlas-web-adapter.ts:99-107`) explaining the structural-vs-allowlist choice and pointing back to the v3 design doc.
- **I6 [Important]** — `pickConfigForKind` JSDoc now documents why duplicate-warn fires once at adapter-factory startup and isn't repeated in the per-call helper (`chat-sdk-instance.ts:62-71`).
- **I7 [Important]** — `broadcast.ts` header comment marks the file as "beyond v3 scope" and points back to this review doc, so future readers don't assume v3 is canonical for the routing layer.
- **I8 [Important]** — `triggerSignalWithSession`'s `_streamId` parameter is now wired through (`runtime.ts:2256-2272`): top-level `streamId` argument merges into `signal.data.streamId` so the API surface stops being a no-op. `job-tools.ts` simplified to use the proper top-level `streamId` field.
- **I9 [Style]** — Deferred. The `vi.fn()` calls in `makeMockAdapter` remain untyped; treat as a fast-follow when the adapter interface next evolves.
- **`createMockAdapter` reuse** — Confirmed not re-exported from the published `chat` package; the local `makeMockAdapter` is the right call. Hoisted to `__test-utils__` so broadcast and notifier tests share it.

## Tests (post-fix)

157 passing across the feature surface:

- `chat-sdk-notifier.test.ts` — 15 cases (was 11 + 4 new openDM tests)
- `broadcast.test.ts` — 8 cases (new)
- `runtime-extract-text.test.ts` — 9 cases (new)
- `chat-sdk-instance.test.ts` — 50 cases (unchanged)
- `adapter-factory.test.ts` — 13 cases (unchanged)
- `communicators.test.ts` — 14 cases (unchanged)
- `platform.test.ts` — 29 cases (unchanged)
- `runtime-extract-text.test.ts` — 9 cases (new)

End-to-end verified after daemon reload:
- Plain HTTP trigger → both Slack + Discord broadcast
- HTTP trigger with `streamId: "discord:..."` (top-level field, now wired through I8 fix) → Slack only (Discord skipped via prefix-fallback)
- handle-chat job → `broadcast_skipped_chat_job`
- Workspace with no chat config → `broadcast_skipped_no_destinations`

## Scope notes

The v3 design document (`docs/plans/2026-04-27-chatsdk-notifier-design.v3.md`) explicitly listed "Routing rules / which communicator for which output" as Out of Scope under § "Out of Scope". This branch ships that deferred routing layer (the broadcast hook + `default_destination` schema + source-skip + `user:<id>` openDM resolution) alongside the v3-faithful notifier core. The `broadcast.ts` header comment now flags this clearly so the next contributor reads v3 as the spec for the notifier and this review doc as the spec for the broadcaster.
