<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import ChatBufferBlur from "$lib/components/chat-buffer-blur.svelte";
  import { Page } from "$lib/components/page";
  import Catalog from "$lib/modules/conversation/catalog.svelte";
  import ChatProvider from "$lib/modules/conversation/chat-provider.svelte";
  import { scrollAttachment } from "$lib/modules/conversation/context.svelte";
  import Footer from "$lib/modules/conversation/footer.svelte";
  import Form from "$lib/modules/conversation/form.svelte";
  import Messages from "$lib/modules/conversation/messages.svelte";
  import SidebarAccounts from "$lib/modules/messages/sidebar-accounts.svelte";
  import SidebarProgress from "$lib/modules/messages/sidebar-progress.svelte";
  import { formatSessionDate } from "$lib/utils/date";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();

  const chatMetaQuery = createQuery(() => ({
    queryKey: ["chat-meta", data.chatId],
    queryFn: async () => {
      const res = await parseResult(
        client.workspaceChat("user")[":chatId"].$get({ param: { chatId: data.chatId } }),
      );
      if (res.ok) return res.data.chat;
      const legacyRes = await parseResult(
        client.chat[":chatId"].$get({ param: { chatId: data.chatId } }),
      );
      if (!legacyRes.ok) return null;
      return legacyRes.data.chat;
    },
    enabled: !data.isNew,
  }));

  const title = $derived(chatMetaQuery.data?.title);
  const updatedAt = $derived(
    chatMetaQuery.data?.updatedAt ? formatSessionDate(chatMetaQuery.data.updatedAt) : undefined,
  );
</script>

<ChatProvider
  chatId={data.chatId}
  isNew={data.isNew}
  initialMessages={data.messages}
  artifacts={data.artifacts}
  onPostSuccess={(id) => goto(`/chat/${id}`, { replaceState: true })}
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
          <header class="chat-header">
            <h1>{title ?? "New conversation"}</h1>
            {#if updatedAt}
              <p>Updated {updatedAt}</p>
            {/if}
          </header>

          <Messages />
          <Footer>
            <Form />
          </Footer>

          <ChatBufferBlur />
        {/if}
      </Page.Content>

      {#if !data.isNew}
        <Page.Sidebar>
          <SidebarProgress messages={context.chat.messages} />

          <!-- TODO: Enable this in a future ticket -->
          <!-- <Page.SidebarSection title="Resources">
            {#if false}
            {:else}
              <a class="sidebar-link" href="https://docs.hellofriday.ai/core-concepts/resources" target="_blank" rel="noopener noreferrer">Learn more about Resources</a>
            {/if}
          </Page.SidebarSection> -->
          <SidebarAccounts messages={context.chat.messages} />
        </Page.Sidebar>
      {/if}
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

  .wrapper h1 {
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

  .chat-header {
    inline-size: 100%;
    margin: 0 auto;
    max-inline-size: var(--size-272);
    padding-block: var(--size-14) 0;
    padding-inline: var(--size-16);

    h1 {
      font-size: var(--font-size-8);
      font-weight: var(--font-weight-6);
      line-height: var(--font-lineheight-1);
    }

    p {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-3);
      margin-block: var(--size-1-5) 0;
      opacity: 0.6;
    }
  }

  .sidebar-link {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.6;
    text-decoration: underline;
  }
</style>
