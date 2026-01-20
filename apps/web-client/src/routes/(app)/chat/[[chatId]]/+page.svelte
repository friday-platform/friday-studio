<script lang="ts">
  import type { PageData } from "./$types";
  import ChatSession from "./chat-session.svelte";

  /**
   * Chat page - thin wrapper around ChatSession that handles remounting.
   *
   * The {#key} block destroys and recreates ChatSession when chatId changes.
   * This eliminates complex reactive state for ID management - the component
   * is created with its ID and that's final for its lifetime.
   */

  const { data }: { data: PageData } = $props();
</script>

<!--
  Key on chatId to remount ChatSession when navigating between chats.
  This ensures:
  1. Fresh Chat instance per chat (no stale state)
  2. chatId is immutable within ChatSession (no reactive ID gymnastics)
  3. Clean lifecycle - no need to sync messages on navigation
-->
{#key data.chatId}
  <ChatSession
    chatId={data.chatId}
    isNew={data.isNew}
    title={data.title}
    initialMessages={data.messages}
    artifacts={data.artifacts}
  />
{/key}
