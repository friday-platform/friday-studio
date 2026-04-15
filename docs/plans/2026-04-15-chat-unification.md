# Chat Unification & User Workspace Model

**Date:** 2026-04-15
**Status:** Draft (v2 — post-PR-2792 reshape, kernel-as-system-workspace)
**Owner:** FAST kernel execution via `chat-unify-exec` workspace
**Builds on:** `docs/plans/2026-03-31-chat-sdk-per-workspace.md` (merged as PR 2792)

## One-line summary

Chat becomes FAST's top-level primitive. A default `user` workspace is created on first run; subsequent workspaces are project/team contexts layered on top. The `conversation` agent + `atlas-conversation` system workspace get quarantined (not deleted). The `kernel` (currently `thick_endive`) becomes a hidden system workspace exposed only via `ATLAS_EXPOSE_KERNEL=1`.

## Context: what PR 2792 already delivered

The recent [Chat SDK per-workspace PR](https://github.com/tempestteam/atlas/pull/2792) (merged) did the foundational work: every workspace gets a lazily-built `ChatSdkInstance` with an `AtlasWebAdapter`, and `POST /api/workspaces/:id/chat` routes through `chat.webhooks.atlas(request)`. `signalToStream` bridges the callback-based `triggerSignalWithSession` API into a `ReadableStream` that both the SSE tap and the Chat SDK's thread consumer read from. The `workspace-chat` agent runs inside that pipeline with workspace-scoped context, skills, and tools.

**What PR 2792 did NOT do:**

- Unify the standalone `POST /api/chat` path — still on the legacy `conversation-stream` → `handle-conversation` → `conversation.agent.ts` FSM route.
- Unify the web-client standalone `/chat/[[chatId]]` route — still hits `/api/chat`.
- Unify the CLI `atlas prompt` command — same.
- Establish any notion of "user workspace" or "kernel workspace as hidden system workspace."
- Layer multiple workspace contexts together in a single chat turn.
- Create any memory automatically on workspace create. Memory is lazy; `MdNarrativeCorpus` creates `~/.atlas/memory/{workspaceId}/narrative/{name}/` on first `.append()`. This is documented here because several phases below depend on it.

This plan finishes the migration PR 2792 started and establishes the user-facing model around it.

## Terminology

- **Kernel workspace** — the FAST platform's internal scheduling/self-modification workspace. Today its runtime ID is `thick_endive`. This plan does NOT rename it (deferred — see Phase 1). It refers to the kernel as "the kernel workspace" or `kernel` conceptually; the underlying ID stays `thick_endive` until a future cleanup pass.
- **User workspace** — the user's personal default space. Created on first run with stable ID `user`. Holds `user-profile`, `notes`, and other personal memories. Default scope for chat.
- **Foreground workspace(s)** — additional workspaces the user has scoped into the current chat, stacked on top of the user workspace. Plural — multiple foregrounds allowed.
- **System workspace** — a workspace flagged as system-level in the registry. Today includes `atlas-conversation`. This plan adds "hidden from chat unless admin" semantics to the kernel. System workspaces are never exposed through the normal workspace picker.
- **Admin mode** — `ATLAS_EXPOSE_KERNEL=1` set in the daemon's environment. When set, the kernel becomes visible in the workspace picker and can be selected as a foreground. Without it, the kernel is invisible to user-facing surfaces.
- **Layered context** — at chat turn time, the agent composes memory + skills + tools + resources from the user workspace (always) plus any foreground workspaces. Default composition rule: union for memory/skills/resources, user-workspace-wins for tool allow-list conflicts.

## Current state (post PR 2792)

```
CLI / standalone web chat             Workspace-scoped web chat
        │                                       │
        ▼                                       ▼
   POST /api/chat              POST /api/workspaces/:id/chat
        │                                       │
        ▼                                       ▼
 triggerSignalWithSession            ChatSdkInstance (lazy)
 "conversation-stream"                         │
        │                                      ▼
        ▼                             AtlasWebAdapter.handleWebhook
 handle-conversation FSM                       │
        │                                      ▼
        ▼                              "chat" signal fired
   conversation agent                           │
        │                                      ▼
        │                              workspace-chat agent
        └──────────────┬───────────────────────┘
                       ▼
                  ChatStorage
       (file-based, ~/.atlas/chats/{workspaceId}/)
```

The right side is modern (PR 2792). The left side is legacy. This plan moves the left side onto the right.

## Target state

```
Every chat — CLI, web default, web workspace-scoped — one path
        │
        ▼
   POST /api/workspaces/:primaryId/chat
   body: { foreground_workspace_ids: [...], ... }
   (:primaryId = "user" by default; a foreground is additive)
        │
        ▼
 getOrCreateChatSdkInstance(primaryId)
        │
        ▼
   AtlasWebAdapter.handleWebhook
        │
        ▼
   "chat" signal with { primaryWsId, foregroundWsIds }
        │
        ▼
   workspace-chat agent
     │
     ├─ load user-profile + composed memory
     ├─ load composed skills
     ├─ load composed tool allow-list (kernel filtered out unless admin)
     └─ stream reply
        │
        ▼
   ChatStorage (primary workspace owns the chat file)
```

**Net benefit:**

- One chat agent, one prompt builder, one set of tools, one storage root. No fork.
- User's personal context (name, notes, scratchpad) is always available — it's in the default scope.
- Kernel is invisible to chat unless the operator explicitly opts in. No accidental kernel leakage into user sessions.
- Foreground workspaces stack cleanly — chatting "about" a specific project pulls that project's memory/skills into scope without breaking the default personal context.
- CLI gets the same layering as web. `atlas prompt "hi"` = user chat; `atlas prompt --workspace X "hi"` = user + X.

## Phases

Each phase is a task_id in the `chat-unify-exec` backlog (`workspaces/chat-unify-exec/workspace.yml`). Playwright routes/assertions are declared per-task where UI validation matters.

### Phase 1: `chat-unify-1-kernel-visibility-flag`

**Goal:** Add `ATLAS_EXPOSE_KERNEL` env var. Kernel workspace (today `thick_endive`) becomes hidden from user-facing surfaces unless the flag is set. Internal APIs (cron, session dispatch, planner) still work unchanged.

**Deferred:** renaming `thick_endive` → `kernel`. That's a separate cleanup pass — too many runtime references to touch tonight. Leave a comment at the top of the workspace config noting the intended rename.

**Files to modify:**
- `apps/atlasd/routes/workspaces/index.ts` — the list route filters out the kernel when `ATLAS_EXPOSE_KERNEL !== "1"`.
- `apps/atlasd/src/atlas-daemon.ts` — read env once at init, stash on daemon context.
- `tools/agent-playground/src/routes/` — workspace picker respects the filter (or the backend filter makes this automatic).
- `apps/web-client/src/routes/(app)/spaces/` — same.
- `CLAUDE.md` — document the env var.

**Exit criteria:**
- `ATLAS_EXPOSE_KERNEL=1 deno task atlas daemon start` — kernel visible in `/api/workspaces`.
- Unset — kernel invisible. Daemon still boots, crons still fire, sessions still dispatch.

**Playwright:**
- `playwright_routes: ["/spaces", "/chat"]`
- `playwright_assertions: ["workspace picker does not include thick_endive when admin flag is unset"]`

### Phase 2: `chat-unify-2-workspace-memory-on-create`

**Goal:** `WorkspaceManager.create()` reads `memory.own` from the new workspace's config and seeds empty narrative directories for each declared memory. Existing workspaces unaffected; lazy creation path is preserved as a fallback.

**Files to modify:**
- `packages/workspace/src/manager.ts` — `create()` calls a new `seedMemories(workspaceId, config.memory?.own ?? [])` helper.
- `packages/memory/src/bootstrap.ts` — new helper that iterates the own list and calls `MdNarrativeCorpus.ensureRoot()` for each.
- `packages/adapters-md/src/md-memory-adapter.ts` — expose `ensureRoot()` as a public method (creates the directory without appending an entry).

**Exit criteria:**
- Creating a new workspace with `memory.own: ["foo"]` in its yaml results in `~/.atlas/memory/{id}/narrative/foo/` existing on disk immediately.
- Existing workspaces continue to lazy-create their memories via the HTTP append path.
- Unit test verifies both paths.

### Phase 3: `chat-unify-3-default-user-workspace-first-run`

**Goal:** Daemon init checks for any non-system user workspaces. If none, creates a `user` workspace with stable ID, `memory.own: [user-profile, notes, scratchpad]`, and default chat-friendly agents.

**Depends on:** Phase 2 (needs memory-on-create so `user-profile` etc. exist as seed directories).

**Files to create:**
- `packages/workspace/src/first-run-bootstrap.ts` — `ensureDefaultUserWorkspace(manager)` — called during `WorkspaceManager.initialize()` after the registry load.
- `packages/workspace/src/user-workspace-template.yml` — static YAML for the default user workspace config.

**Files to modify:**
- `packages/workspace/src/manager.ts` — `initialize()` calls `ensureDefaultUserWorkspace()` after the existing user-workspace enumeration.

**Exit criteria:**
- Fresh daemon start with empty `~/.atlas/workspaces/` results in a `user` workspace existing after boot.
- Daemon start with an existing `user` workspace is a no-op.
- `user` workspace has `user-profile`, `notes`, `scratchpad` narrative directories on disk.
- `deno task atlas workspace list` shows the `user` workspace.

### Phase 4: `chat-unify-4-layered-chat-context`

**Goal:** Teach `workspace-chat.agent.ts` to accept a list of foreground workspace IDs from the chat signal payload. At turn time, compose memory + skills + tools + resources from the primary (user) workspace plus each foreground, in a deterministic order. Kernel workspace is excluded from composition unless `ATLAS_EXPOSE_KERNEL=1`.

**Depends on:** Phase 1 (env flag).

**Files to modify:**
- `packages/system/agents/workspace-chat/workspace-chat.agent.ts` — the handler reads `foreground_workspace_ids` from the signal payload, fetches each workspace's config + memory + skills, and merges into context. Tool allow-list is the union (primary wins on conflict).
- `apps/atlasd/src/chat-sdk/chat-sdk-instance.ts` — the message handler passes `foreground_workspace_ids` through the signal payload.
- `apps/atlasd/routes/workspaces/chat.ts` — route accepts `foreground_workspace_ids` in the POST body and plumbs it through.

**Exit criteria:**
- Unit test: chat against `user` with `foreground_workspace_ids: [X]` sees both workspaces' memory in the composed context.
- Unit test: kernel ID in foregrounds is dropped unless env flag is set.
- Integration test: POST `/api/workspaces/user/chat` with a foreground ID returns a reply that references content from both workspaces.

### Phase 5: `chat-unify-5-first-chat-onboarding`

**Goal:** On every chat turn, the agent loads `user/user-profile`. If it's empty or missing a `name`, the system prompt gets an onboarding clause: "introduce yourself as Friday, ask what to call the user, then call `memory_save` when they answer." Idempotent — check before ask.

**Depends on:** Phase 3 (needs `user` workspace to exist) and Phase 4 (user-profile loading hooks into the new context composition).

**Files to modify:**
- `packages/system/agents/workspace-chat/workspace-chat.agent.ts` — system prompt builder includes an onboarding clause if `userProfile.name` is absent.
- `packages/agent-sdk/src/memory-scope.ts` (or wherever `memory_save` is defined) — ensure the tool can scope writes to the primary workspace's narrative memory.

**Exit criteria:**
- New daemon + new user workspace: first chat message elicits "Hello, I'm Friday. What should I call you?"
- User replies "Ken": agent calls `memory_save` → `user/user-profile` gains a "User's name is Ken" entry.
- Next message: agent greets "Ken" by name without re-asking.
- Decline ("I'd rather not say") still persists a decline entry so the ask doesn't repeat.

**Playwright:**
- `playwright_routes: ["/chat/new"]`
- `playwright_assertions: ["fresh user sees Friday greeting asking for name", "replying with a name triggers a memory save and subsequent greeting uses the name", "reloading preserves the greeting state"]`

### Phase 6: `chat-unify-6-api-chat-delegates-to-user-workspace`

**Goal:** `POST /api/chat` becomes a thin delegator to `POST /api/workspaces/user/chat`. The legacy `triggerSignalWithSession("conversation-stream", ...)` call is removed. `conversation-stream` signal, `handle-conversation` FSM job, and `conversation.agent.ts` are **quarantined with a big legacy comment** — not deleted.

**Depends on:** Phase 4 (layered chat exists).

**Files to modify:**
- `apps/atlasd/routes/chat.ts` — replace handler body with delegation to the workspace chat SDK instance for the `user` workspace. `GET /api/chat/:chatId` keeps transcript retrieval; add a fallback to read from `~/.atlas/chats/user/` for legacy chats that were under `~/.atlas/chats/atlas-conversation/`.
- `packages/system/agents/conversation/conversation.agent.ts` — add a `// LEGACY — quarantined as of chat-unify. Do not add features. Will be removed after callsite audit.` header. Keep the file.
- `packages/system/workspaces/conversation.yml` — add a similar header. Keep the signal + job wired (but nothing fires it from user surfaces anymore).

**Exit criteria:**
- `deno task atlas prompt "hi"` still works and returns a reply (now via user workspace + workspace-chat agent).
- `deno task atlas chat <chatId>` retrieves transcripts for both new and legacy chats.
- `grep -r "conversation-stream" apps/ packages/` shows only the quarantined file and its direct wiring.

### Phase 7: `chat-unify-7-web-and-cli-cutover-to-user`

**Goal:** Web-client standalone `/chat/[[chatId]]` route and CLI `atlas prompt` both post directly to the user workspace's chat endpoint. The `/api/chat` thin delegator from Phase 6 becomes redundant (but stays as a legacy shim — Phase 9 decides whether to remove).

**Depends on:** Phase 6.

**Files to modify:**
- `apps/web-client/src/lib/modules/conversation/load-chat.ts` — standalone loader uses the workspace-scoped path with `user`.
- `apps/web-client/src/lib/modules/conversation/chat-provider.svelte` — transport defaults to `/api/workspaces/user/chat`.
- `apps/web-client/src/routes/(app)/chat/[[chatId]]/+page.svelte` — route calls the user workspace endpoint.
- `apps/atlas-cli/src/commands/prompt.ts` — no-flag default posts to `/api/workspaces/user/chat`; `--workspace X` posts to `/api/workspaces/user/chat` with `foreground_workspace_ids: [X]`.

**Exit criteria:**
- `deno task atlas prompt "hi"` → user workspace chat.
- `deno task atlas prompt --workspace braised_biscuit "hi"` → user workspace chat with braised_biscuit as foreground. Response shows awareness of braised_biscuit's memory/skills.
- Web `/chat/new` and `/spaces/X/chat/new` both work against the unified path.

**Playwright:**
- `playwright_routes: ["/chat/new", "/spaces/braised_biscuit/chat/new"]`
- `playwright_assertions: ["standalone chat works end-to-end", "workspace-scoped chat works end-to-end", "foreground workspace memory is referenced in replies"]`

### Phase 8: `chat-unify-8-chat-as-top-level-ui`

**Goal:** Web-client lands on `/chat` by default. Workspace picker is inside the chat UI and lets the user pin multiple foreground workspaces. Existing `/spaces/{id}/chat` pages remain for deep-linking but become a thin wrapper that pre-fills the foreground picker.

**Depends on:** Phase 7.

**Files to modify:**
- `apps/web-client/src/routes/(app)/+layout.svelte` or the root landing route — redirect to `/chat` on launch.
- `apps/web-client/src/lib/modules/conversation/chat-provider.svelte` — add a `<ForegroundWorkspacePicker>` sub-component. The picker shows all user-visible workspaces (respecting the kernel hide flag), lets the user toggle them into the foreground list.
- `apps/web-client/src/routes/(app)/spaces/[spaceId]/chat/[[chatId]]/+page.svelte` — pre-sets the foreground list to `[spaceId]` on mount; otherwise reuses the unified chat provider.

**Exit criteria:**
- Fresh launch → user lands at `/chat`.
- Chat UI shows the user workspace as base + empty foreground list + a picker.
- Selecting a workspace adds it to the foreground list; subsequent messages see that workspace's context.
- Deselecting removes it.

**Playwright:**
- `playwright_routes: ["/", "/chat", "/spaces/braised_biscuit/chat/new"]`
- `playwright_assertions: ["root redirects to /chat", "foreground picker toggles workspace context", "deep-linked workspace chat pre-fills foreground"]`

### Phase 9: `chat-unify-9-observability-and-cleanup-audit`

**Goal:** Emit chat turn events into the FSM event bus so workspace chat becomes visible in `/api/sessions?workspaceId=X`. Audit the quarantined files (conversation agent, `atlas-conversation` system workspace, `/api/chat` thin delegator) and produce a "safe-to-delete" report — this phase does NOT delete anything; it produces a document listing every remaining reference so a future cleanup pass can make the call with full information.

**Depends on:** Phase 8 (everything migrated).

**Files to modify:**
- `apps/atlasd/src/chat-sdk/chat-sdk-instance.ts` — emit session lifecycle events (`session.started`, `session.completed`) for each chat turn.
- `packages/core/src/stream-event-filter.ts` — ensure new events are client-safe where appropriate.
- New doc: `docs/chat-architecture.md` — the canonical "how chat works" reference after unification.

**Files to create:**
- `docs/plans/2026-04-15-chat-unification-cleanup-audit.md` — enumerates every reference to `conversation` agent, `atlas-conversation` workspace, `conversation-stream` signal, and `/api/chat`. For each, notes whether it can be removed, what breaks if it is, and the suggested order.

**Exit criteria:**
- A chat turn on `user` workspace shows up in `GET /api/sessions?workspaceId=user`.
- The cleanup-audit doc exists and lists every remaining legacy reference.

## Risks and rollbacks

- **Phase 3 (first-run):** if the `user` workspace creation races with daemon startup, subsequent boots could double-create. Mitigation: the ensure-function checks for the stable ID and short-circuits.
- **Phase 4 (layered context):** composing tool allow-lists across workspaces risks accidentally exposing a kernel tool via a foreground workspace that mounts kernel as a dep. Mitigation: the env flag gate is applied AFTER composition — kernel-marked tools get stripped regardless of source.
- **Phase 6 (api-chat delegation):** existing chats in `~/.atlas/chats/atlas-conversation/` must still load. The legacy shim fallback in the GET handler handles this. Until the fallback is tested, no legacy chats get moved.
- **Phase 7 (cutover):** breaking the CLI or web chat is user-visible. Each phase ships with a passing Playwright test before the next phase starts; if any phase fails validation the backlog re-queues the task.
- **Phase 8 (UI inversion):** landing on /chat by default is a UX change. If the existing user flow relies on landing somewhere else, add a preference toggle. Not blocking.

## Testing strategy

- Every phase that touches backend code ships unit tests alongside implementation (reviewer enforces).
- Phases 4, 6, 7 ship integration tests hitting the real HTTP route against a local daemon.
- Phases 5, 7, 8 ship Playwright assertions against the already-running playground. The `chat-unify-exec` workspace's `step_browser_test` state runs them after `step_review` approves.
- Smoke test after every phase: `deno task atlas prompt "hi"` + transcript retrieve + standalone web chat + workspace web chat all must work.

## Bootstrap order

1. Land this plan doc.
2. Verify `workspaces/chat-unify-exec/workspace.yml` (already written) still matches the phase shape. Adjust the architect/reviewer prompts if needed to reference this updated plan.
3. Seed `thick_endive/narrative/autopilot-backlog` with 9 tasks, priorities 100 → 20 descending.
4. Fire `autopilot-tick` manually once to confirm the planner picks Phase 1.
5. Cron takes over.

## Non-goals

- Renaming `thick_endive` → `kernel` (deferred; leave a comment).
- Deleting the `conversation` agent or `atlas-conversation` system workspace. Both are quarantined, not removed.
- Migrating existing chat files. Legacy chats under `~/.atlas/chats/atlas-conversation/` load via the Phase 6 fallback shim. New chats go under `~/.atlas/chats/user/`.
- Multi-user FAST. Single-user local-only. User-profile memory lives in the `user` workspace; splitting that into a dedicated user scope is a future concern.
- Chat UX affordances beyond the foreground picker (inline artifact rendering, slash commands, etc).
- Chat storage migration to SQLite or a DB. File-based JSON stays.
