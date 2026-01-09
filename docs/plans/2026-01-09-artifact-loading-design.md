# Chat Artifact Loading Design

**Date:** 2026-01-09
**Status:** Draft
**Linear:** [TEM-3388](https://linear.app/tempestteam/issue/TEM-3388/fix-n1-api-calls-when-loading-chat-with-multiple-artifacts)

## Problem

When loading a chat page with multiple artifacts, each `DisplayArtifact` component fires its own API call independently, causing N+1 API calls. A chat with 5 artifacts = 5+ sequential API calls during page load, causing artifacts to "pop in" after the page renders.

## Solution

Batch-fetch all artifacts at the page level during SvelteKit's load phase, provide them via Svelte context, and have display components check the context before fetching.

## Data Flow

### Existing Chat Load

```
+page.ts
  ├─ fetch chat (messages)
  ├─ extract artifact IDs from messages
  ├─ batch fetch artifacts + file contents
  └─ return { chatId, title, messages, artifacts: Map<id, ArtifactWithContents> }

+page.svelte
  ├─ setContext('artifacts', data.artifacts)
  └─ render messages

DisplayArtifact
  ├─ getContext('artifacts')
  ├─ artifacts.get(artifactId)
  └─ render (no fetch needed)
```

### Streaming New Artifacts

```
Message streams in with display_artifact tool call
  ↓
DisplayArtifact mounts
  ├─ getContext('artifacts')
  ├─ artifacts.get(artifactId) → undefined (not in map)
  ├─ fetch artifact + contents directly
  └─ render when loaded
```

The display component has one code path: check map, fetch on miss. The page load pre-warms the map so existing chats hit the cache. Streaming naturally misses and fetches on demand.

## Design Decisions

1. **Page-level loading** - Artifacts fetched in `+page.ts`, not a global store. Avoids building on the `chatContext.chats` map which is slated for removal.

2. **Svelte context for distribution** - Artifacts provided via `setContext()` rather than prop drilling through message rendering layers.

3. **Include file contents in batch** - Prefetch file contents alongside metadata to eliminate secondary waterfall for file-type artifacts.

4. **Context is immutable** - Artifacts fetched during streaming stay component-local. No reactive updates to context after page load.

## Implementation

### Backend: Extend Batch Endpoint

**File:** `apps/atlasd/routes/artifacts.ts`

Extend `/api/artifacts/batch-get` to optionally include file contents:

```typescript
// Current
POST /api/artifacts/batch-get
Body: { ids: string[] }
Response: { artifacts: Artifact[] }

// New
POST /api/artifacts/batch-get
Body: { ids: string[], includeContents?: boolean }
Response: { artifacts: Array<Artifact & { contents?: string }> }
```

When `includeContents: true`:
- For each file-type artifact, read file contents and attach
- Non-file artifacts return as-is (no `contents` field)
- Parallel file reads with `Promise.all`

Extract the existing contents-reading logic from `GET /api/artifacts/:id` into a shared helper.

### Frontend: Page Load

**File:** `apps/web-client/src/routes/(app)/chat/[chatId]/+page.ts`

```typescript
export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(
    client.chat[":chatId"].$get({ param: { chatId: params.chatId } })
  );

  if (!res.ok) redirect(302, "/");

  const messages = await validateAtlasUIMessages(res.data.messages);

  // Extract artifact IDs from messages
  const artifactIds = extractArtifactIds(messages);

  // Batch fetch if any artifacts exist
  let artifacts = new Map<string, ArtifactWithContents>();
  if (artifactIds.length > 0) {
    const artifactRes = await parseResult(
      client.artifactsStorage["batch-get"].$post({
        json: { ids: artifactIds, includeContents: true }
      })
    );
    if (artifactRes.ok) {
      artifacts = new Map(
        artifactRes.data.artifacts.map(a => [a.id, a])
      );
    }
  }

  return {
    title: res.data.chat.title,
    chatId: res.data.chat.id,
    messages,
    artifacts,
  };
};
```

**Helper:** `extractArtifactIds(messages)`
- Walk through messages
- Find `tool_call` parts where `toolName === 'display_artifact'`
- Pull `artifactId` from metadata
- Dedupe and return array

### Frontend: Context Setup

**File:** `apps/web-client/src/routes/(app)/chat/[chatId]/+page.svelte`

```typescript
import { setContext } from 'svelte';

const { data }: { data: PageData } = $props();

setContext('artifacts', data.artifacts);
```

### Frontend: Display Component

**File:** `apps/web-client/src/lib/modules/artifacts/display.svelte`

```typescript
import { getContext } from 'svelte';

const { artifactId } = $props();

const artifactsMap = getContext<Map<string, ArtifactWithContents>>('artifacts');

let artifact = $state<ArtifactData | null>(null);
let contents = $state<string | null>(null);

$effect(() => {
  const cached = artifactsMap?.get(artifactId);
  if (cached) {
    // Cache hit - use preloaded data
    artifact = cached.data;
    contents = cached.contents ?? null;
  } else {
    // Cache miss (streaming case) - fetch directly
    grabArtifact();
  }
});

async function grabArtifact() {
  const result = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: artifactId } })
  );
  if (result.ok) {
    artifact = ArtifactDataSchema.parse(result.data.artifact.data);
    contents = result.data.contents ?? null;
  }
}
```

### Frontend: File Component

**File:** `apps/web-client/src/lib/components/primitives/file.svelte`

Remove the independent contents fetch. Receive `contents` as a prop from parent `display.svelte`.

## File Manifest

| File | Change |
|------|--------|
| `apps/atlasd/routes/artifacts.ts` | Extend batch-get to accept `includeContents`, attach file contents |
| `apps/web-client/src/routes/(app)/chat/[chatId]/+page.ts` | Extract artifact IDs, batch fetch with contents |
| `apps/web-client/src/routes/(app)/chat/[chatId]/+page.svelte` | Set artifacts context |
| `apps/web-client/src/lib/modules/artifacts/display.svelte` | Check context first, fetch on miss |
| `apps/web-client/src/lib/components/primitives/file.svelte` | Remove fetch, receive contents as prop |

## What This Fixes

- **Existing chats:** 1 batch call instead of N+1 individual calls
- **UX:** Artifacts render immediately with page, no pop-in

## What This Doesn't Change

- No new global stores
- No changes to artifact API shape (just optional param)
- No changes to message structure
- Streaming behavior unchanged (fetch on demand)
