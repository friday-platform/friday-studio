<script lang="ts">
  import { goto } from "$app/navigation";
  import ChatProvider from "$lib/modules/conversation/chat-provider.svelte";
  import Form from "$lib/modules/conversation/form.svelte";
  import { nanoid } from "$lib/utils/id";

  let { workspaceId }: { workspaceId: string } = $props();
</script>

<ChatProvider
  chatId={`chat_${nanoid()}`}
  isNew
  initialMessages={[]}
  artifacts={new Map()}
  onPostSuccess={(id) => goto(`/spaces/${workspaceId}/chat/${id}`, { replaceState: false })}
>
  <div class="wrapper">
    <div class="form-wrapper">
      <Form />
    </div>
  </div>
</ChatProvider>

<style>
  .wrapper {
    background: linear-gradient(to top, var(--color-surface-1) 75%, transparent);
    margin-block: calc(-1 * var(--size-7)) calc(-1 * var(--size-12));
    margin-inline: calc(-1 * var(--size-14));
    padding-block: var(--size-7) var(--size-12);
    padding-inline: var(--size-14);
    position: sticky;
    inset-block-end: 0;
    z-index: var(--layer-2);
  }

  .form-wrapper {
    margin-inline: auto;
    max-inline-size: var(--size-144);
  }
</style>
