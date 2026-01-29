<script lang="ts">
  import ChatSession from "./(components)/chat-session.svelte";
  import type { PageData } from "./$types";

  /**
   * Chat page - thin wrapper around ChatSession.
   *
   * ChatSession persists across navigations. When chatId changes, $derived
   * blocks recreate the Chat/transport instances. The beforeNavigate guard
   * skips cleanup for programmatic goto() calls (URL updates on new chats).
   */

  const { data }: { data: PageData } = $props();
</script>

<ChatSession
  chatId={data.chatId}
  isNew={data.isNew}
  title={data.title}
  initialMessages={data.messages}
  artifacts={data.artifacts}
/>
