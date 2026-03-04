<!-- v2 - 2026-02-25 - Generated via /improving-plans from docs/plans/2026-02-25-chat-provider-extraction.md -->

# Chat Provider Extraction

**Date**: 2026-02-25
**Type**: Refactor
**Branch**: david/tem-3653-add-chat-view-in-workspaces

## Problem Statement

`chat-session.svelte` is a monolith that mixes functional logic (Chat instance,
transport, navigation, analytics, reconnection) with UI (messages, form, scroll,
catalog, breadcrumbs). The chat view is used in both the global `/chat` route and
the new `/spaces/[spaceId]/chat` route, but they need different behaviors:

- Different URL redirects on new chat creation
- The space chat page should not show the catalog
- Future space-specific UI (sidebar, breadcrumbs) that diverge further

Modifying `chat-session.svelte` to support both cases via flags would add
complexity. A composable split is cleaner.

## Solution

Extract a headless `ChatProvider` component that owns all functional concerns and
exposes state via `{@render children(ctx)}`. Refactor `chat-session.svelte` to
consume the provider. Pages stay unchanged.

This is step 1 of a larger composability effort. A later step will have the space
chat page compose `ChatProvider` directly with its own UI.

## File Paths

All paths relative to `apps/web-client/src/lib/modules/conversation/`.

| File | Action |
|---|---|
| `chat-provider.svelte` | **New** — headless provider |
| `chat-session.svelte` | **Modified** — wraps its UI in the provider |

Reference: read `chat-session.svelte` first. Everything being extracted lives
there today. The two consumers are:

- `apps/web-client/src/routes/(app)/chat/[[chatId]]/+page.svelte`
- `apps/web-client/src/routes/(app)/spaces/[spaceId]/chat/[[chatId]]/+page.svelte`

Neither page file changes in this step.

## Scope

### What changes

1. **New file**: `chat-provider.svelte` — headless provider
2. **Modified**: `chat-session.svelte` — wraps its UI in the provider

### What does NOT change

- `/chat/[[chatId]]/+page.svelte` — no diff
- `/spaces/[spaceId]/chat/[[chatId]]/+page.svelte` — no diff (yet)
- No new props on `ChatSession` from the page's perspective

## Implementation

### New pattern: headless provider with snippet args

This introduces a new pattern to the web-client. Existing components use
`{@render children()}` (no args) for slot composition; this is the first to pass
typed state down via snippet args.

Svelte 5 snippet-with-args reference:

```svelte
<!-- provider.svelte -->
<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children: Snippet<[{ value: string }]> } = $props();
</script>
{@render children({ value: "hello" })}

<!-- consumer.svelte -->
<Provider>
  {#snippet children(ctx)}
    <p>{ctx.value}</p>
  {/snippet}
</Provider>
```

### `chat-provider.svelte`

**Props:**

```typescript
interface Props {
  chatId: string;
  title: string | undefined;
  initialMessages: AtlasUIMessage[];
  artifacts: Map<string, ArtifactWithContents>;
  isNew: boolean;
  onPostSuccess?: (chatId: string) => void;
  children: Snippet<[ChatContext]>;
}
```

**Exposed context (via snippet):**

```typescript
interface ChatContext {
  chatId: string;
  title: string | undefined;
  chat: Chat<AtlasUIMessage>;
  handleStop: () => Promise<void>;
  turnStartedAt: number | null;
  ready: boolean;
}
```

`chat` is the full `Chat<AtlasUIMessage>` instance from `@ai-sdk/svelte`.
Downstream components like `ConnectService` and `WorkspacePlan` call
`chat.sendMessage()` directly on it — they receive it via props from the UI, not
from the provider.

**Logic that moves from `chat-session.svelte` into the provider:**

- The `transport` `$derived` block (`DefaultChatTransport` with custom fetch
  wrapper)
- The `chat` `$derived` block (`new Chat(...)`)
- `hasUpdatedUrl` state and its `$effect` reset on `isNew`
- The `onPostSuccess` call site (replaces the hardcoded
  `goto('/chat/${chatId}')`)
- Query invalidation on successful POST (always fires, not configurable)
- `prepareSendMessagesRequest`
- `beforeNavigate` / `afterNavigate` guards
- `onMount` calling `setup()` and `reconnect()`
- `setup()` function — sets `ready` to `true` via setTimeout
- `reconnect()` function (resumeStream + OAuth return flow)
- Stream lifecycle analytics (`$effect` tracking status transitions)
- `handleStop()` (DELETE endpoint + `chat.stop()`)
- `resumeAbortController` state and abort logic
- `turnStartedAt` state (from `X-Turn-Started-At` header)
- `streamStartTime` and `previousStatus` state
- Artifacts `setContext(ARTIFACTS_KEY, artifacts)`

**`ready` implementation note:** `ready` starts `false`, set to `true` via
`setTimeout(..., 100)` after navigation/mount to trigger CSS opacity transition.
The delay is intentional — without it the 0→1 opacity transition doesn't fire
because there's no frame gap.

**Renders:** Only `{@render children(ctx)}` — no DOM output.

### `chat-session.svelte`

**Loses:** All functional logic listed above.

**Keeps:**

- Scroll management (`scrollContainer`, `userHasScrolled`, auto-scroll)
- `message` textarea state and `textareaAdditionalSize`
- `actionsAfterLastUser` derived from `ctx.chat.messages`
- `showDetails` SvelteMap
- Message rendering (all message type components)
- `MessageForm` with `onSubmit` / `onStop`
- `Breadcrumbs`, `Catalog`, `Outline`, `Progress`, `ChatBufferBlur`
- File drop handling
- All styles

**Structure after refactor:**

```svelte
<ChatProvider
  {chatId} {title} {initialMessages} {artifacts} {isNew}
  onPostSuccess={(id) => goto(`/chat/${id}`, { replaceState: true })}
>
  {#snippet children(ctx)}
    <div class="chat" class:visible={ctx.ready} ...>
      <!-- existing UI, using ctx.chat and ctx.handleStop -->
    </div>
  {/snippet}
</ChatProvider>
```

`chat-session.svelte` keeps its existing Props interface so pages don't change.
It forwards `chatId`, `title`, `initialMessages`, `artifacts`, `isNew` to the
provider and uses `ctx` internally.

## Testing

- Manual: verify global chat works identically (new chat, existing chat, stream
  resume, OAuth return, stop, navigation)
- Manual: verify space chat works identically
- No new unit tests needed — this is a structural refactor with no behavior
  change

## Out of Scope

- Space chat page composing the provider directly (step 2)
- Extracting `chat-ui.svelte` as a reusable message list component (step 2)
- Removing catalog from chat-session (step 2 — space page won't use
  chat-session)
- Any new features or UI changes
