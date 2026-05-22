<script lang="ts">
  import { Button, ListDetail } from "@atlas/ui";
  import { generateChatId } from "@atlas/core/chat/id";
  import { goto } from "$app/navigation";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import ChatListPanel from "$lib/components/chat/chat-list-panel.svelte";
  import UserChat from "$lib/components/chat/user-chat.svelte";
  import WorkspaceDropdown from "$lib/components/workspace/workspace-dropdown.svelte";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
  const workspaceId = $derived(page.params.workspaceId ?? "user");

  const SIDEBAR_KEY = "atlas:chat:sidebar-collapsed";

  function readSidebarCollapsed(): boolean {
    if (!browser) return false;
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      // localStorage unavailable (private mode / disabled) — keep default
      return false;
    }
  }

  // Seed from storage at init so there's no SSR-default → stored-value
  // flash, then persist on every change.
  let sidebarCollapsed = $state(readSidebarCollapsed());

  $effect(() => {
    if (!browser) return;
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // ignore quota / availability errors
    }
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Ctrl+B — hide / reveal the chat list sidebar. Cmd+B is reserved
    // for Mac browser's bookmarks bar so we don't intercept it.
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === "b") {
      e.preventDefault();
      sidebarCollapsed = !sidebarCollapsed;
    }
  }

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
    // Bare `/chat` redirects to `active_setup_session_id` when one is set;
    // mint a fresh id client-side so this button always opens a new session.
    const next = generateChatId();
    goto(`/platform/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(next)}`);
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#key workspaceId}
  <ListDetail bind:sidebarCollapsed>
    {#snippet header()}
      <WorkspaceDropdown selected={workspaceId} />
      <Button variant="secondary" size="small" onclick={handleNewChat}>New chat</Button>
    {/snippet}

    {#snippet sidebar()}
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
