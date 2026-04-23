<script lang="ts">
  import UserChat from "$lib/components/chat/user-chat.svelte";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
</script>

<UserChat chatId={data.chatId} />
