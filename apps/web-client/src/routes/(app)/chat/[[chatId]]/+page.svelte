<script lang="ts">
  import { replaceState } from "$app/navigation";
  import ChatBufferBlur from "$lib/components/chat-buffer-blur.svelte";
  import { Page } from "$lib/components/page";
  import Catalog from "$lib/modules/conversation/catalog.svelte";
  import ChatProvider from "$lib/modules/conversation/chat-provider.svelte";
  import { scrollAttachment } from "$lib/modules/conversation/context.svelte";
  import Footer from "$lib/modules/conversation/footer.svelte";
  import Form from "$lib/modules/conversation/form.svelte";
  import Messages from "$lib/modules/conversation/messages.svelte";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
</script>

<ChatProvider
  chatId={data.chatId}
  isNew={data.isNew}
  initialMessages={data.messages}
  artifacts={data.artifacts}
  onPostSuccess={(id) => replaceState(`/chat/${id}`, {})}
>
  {#snippet children(context)}
    <Page.Root>
      <Page.Content padded={false} {@attach scrollAttachment(data.isNew, context)}>
        {#if data.isNew && context.chat.messages.length === 0}
          <div class="wrapper">
            <h1>What do you want to do today?</h1>
            <div class="form-wrapper">
              <Form />
            </div>

            <Catalog />
          </div>
        {:else}
          <Messages />
          <Footer>
            <Form />
          </Footer>

          <ChatBufferBlur />
        {/if}
      </Page.Content>

      <!-- TODO: add back when sidbar is more complete -->
      <!-- {#if !data.isNew}
        <Page.Sidebar>
          <Outline />
        </Page.Sidebar>
      {/if} -->
    </Page.Root>
  {/snippet}
</ChatProvider>

<style>
  .wrapper {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: scroll;
    padding-block: 0 var(--size-16);
    padding-inline: var(--size-4);
    position: relative;
    scrollbar-width: thin;
    scroll-behavior: smooth;
  }

  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    padding-block: var(--size-16) var(--size-4);
    text-align: center;
  }

  .form-wrapper {
    margin: 0 auto;
    inline-size: 100%;
    max-inline-size: var(--size-160);
    padding-inline: var(--size-8);
  }
</style>
