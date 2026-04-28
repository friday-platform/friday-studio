<script lang="ts">
  import UserChat from "$lib/components/chat/user-chat.svelte";
  import type { PageData } from "./$types";
  import { page } from "$app/state";

  const { data }: { data: PageData } = $props();
</script>

{#key page.params.workspaceId}
  <UserChat chatId={data.chatId} />
{/key}
