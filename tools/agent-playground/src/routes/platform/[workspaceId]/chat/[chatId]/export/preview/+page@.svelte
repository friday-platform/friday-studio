<script lang="ts">
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { buildSegments, extractImages } from "@atlas/core/chat/export/render";
  import ChatMessageList from "$lib/components/chat/chat-message-list.svelte";
  import {
    setExportContext,
    type ArtifactPrefetch,
  } from "$lib/components/chat/export-context";
  import type { ChatMessage } from "$lib/components/chat/types";
  import { artifactZipPath } from "$lib/export/artifact-zip-path";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  const { data }: Props = $props();

  /**
   * Pre-fetched artifact map keyed by id. The trust contract on
   * `ExportContext` is that every artifactId referenced in the chat is
   * present here; if a card receives an unknown id, it surfaces a
   * placeholder rather than spinning forever (no JS in the export, so a
   * loader can never resolve).
   *
   * `csr = false` means this component runs once server-side and never
   * remounts client-side — capturing the initial `data` value is exactly
   * the behaviour we want, hence the `state_referenced_locally` ignore
   * on the `setExportContext` call below.
   */
  // svelte-ignore state_referenced_locally
  const artifactMap: Map<string, ArtifactPrefetch> = new Map(
    data.artifacts.map((a) => [a.id, a]),
  );

  /**
   * Resolve an artifact id to its zip-relative asset path. Falls back to
   * a stable placeholder when the id is missing from the prefetch map so
   * the rendered HTML still produces a recognisable broken link instead
   * of an empty `src`. The card itself surfaces the missing-from-context
   * error message; this just keeps the HTML well-formed.
   */
  function resolveUrl(id: string): string {
    const prefetch = artifactMap.get(id);
    if (!prefetch) return `assets/artifacts/${id}/missing`;
    return artifactZipPath({
      id,
      mimeType: prefetch.mimeType,
      originalName: prefetch.originalName,
      title: prefetch.title,
    });
  }

  setExportContext({ artifacts: artifactMap, resolveUrl });

  /**
   * Translate a validated `AtlasUIMessage` into the `ChatMessage` shape
   * `<ChatMessageList>` consumes. Validation happens at the
   * `+page.server.ts` boundary (`validateAtlasUIMessages`) so we receive
   * messages already typed.
   *
   * Unlike `user-chat.svelte`, no phantom-assistant filter: that
   * workaround papers over an AI-SDK streaming-timing bug that can't
   * fire in batch render. Faithful render of persisted state wins.
   */
  function toChatMessage(msg: AtlasUIMessage): ChatMessage {
    const meta = msg.metadata ?? {};
    const role: ChatMessage["role"] =
      msg.role === "user" ? "user" : msg.role === "system" ? "system" : "assistant";
    const tsSource = meta.timestamp ?? meta.startTimestamp;
    const timestamp = tsSource ? Date.parse(tsSource) || 0 : 0;
    return {
      id: msg.id,
      role,
      segments: buildSegments(msg),
      timestamp,
      images: extractImages(msg),
      metadata: {
        agentId: meta.agentId,
        jobName: meta.jobName,
        provider: meta.provider,
        modelId: meta.modelId,
        sessionId: meta.sessionId,
        startTimestamp: meta.startTimestamp,
        timestamp: meta.timestamp,
        endTimestamp: meta.endTimestamp,
      },
    };
  }

  const chatMessages: ChatMessage[] = $derived(data.messages.map(toChatMessage));
  const title = $derived(data.chat.title ?? data.chat.id);
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<div class="export-preview">
  <header class="export-header">
    <h1>{title}</h1>
  </header>
  <ChatMessageList messages={chatMessages} />
</div>

<style>
  .export-preview {
    max-inline-size: 56rem;
    margin-inline: auto;
    padding: var(--size-3, 1rem);
  }
  .export-header {
    margin-block-end: var(--size-3, 1rem);
  }
  .export-header h1 {
    font-size: var(--font-size-5, 1.5rem);
    margin: 0;
  }
</style>
