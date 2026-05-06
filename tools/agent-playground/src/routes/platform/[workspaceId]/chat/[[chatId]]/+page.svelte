<script lang="ts">
  import { Button, IconSmall, ListDetail } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import ChatListPanel from "$lib/components/chat/chat-list-panel.svelte";
  import UserChat from "$lib/components/chat/user-chat.svelte";
  import WorkspaceDropdown from "$lib/components/workspace/workspace-dropdown.svelte";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
  const workspaceId = $derived(page.params.workspaceId ?? "user");

  function handleSelectChat(chatId: string) {
    if (chatId === data.chatId) return;
    goto(`/platform/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`);
  }

  function handleDeleteChat(deletedId: string, nextChatId: string | null) {
    if (deletedId !== data.chatId) return;
    const base = `/platform/${encodeURIComponent(workspaceId)}/chat`;
    goto(nextChatId ? `${base}/${encodeURIComponent(nextChatId)}` : base);
  }

  function handleNewChat() {
    goto(`/platform/${encodeURIComponent(workspaceId)}/chat`);
  }
</script>

{#key workspaceId}
  <ListDetail>
    {#snippet header()}
      <WorkspaceDropdown selected={workspaceId} />
    {/snippet}

    {#snippet sidebar()}
      <Button variant="secondary" size="small" onclick={handleNewChat}>
        {#snippet prepend()}
          <IconSmall.Plus />
        {/snippet}
        New chat
      </Button>
      <ChatListPanel
        {workspaceId}
        currentChatId={data.chatId}
        onSelect={handleSelectChat}
        onDelete={handleDeleteChat}
      />
    {/snippet}

    <UserChat chatId={data.chatId} />
  </ListDetail>
{/key}
