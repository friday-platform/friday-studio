<script lang="ts">
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { createInfiniteQuery, keepPreviousData } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import ChatBufferBlur from "$lib/components/chat-buffer-blur.svelte";
  import Dot from "$lib/components/dot.svelte";
  import { Page } from "$lib/components/page";
  import ChatProvider from "$lib/modules/conversation/chat-provider.svelte";
  import { scrollAttachment } from "$lib/modules/conversation/context.svelte";
  import Footer from "$lib/modules/conversation/footer.svelte";
  import Form from "$lib/modules/conversation/form.svelte";
  import Messages from "$lib/modules/conversation/messages.svelte";
  import { pendingWorkspaceMessage } from "$lib/modules/conversation/pending-message.svelte";
  import { listWorkspaceChats } from "$lib/queries/workspace-chats";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const appCtx = getAppContext();
  const workspaceChatApi = $derived(`${getAtlasDaemonUrl()}/api/workspaces/${data.spaceId}/chat`);
  const initialPendingMessage = pendingWorkspaceMessage.get();

  const workspaceChatsQuery = createInfiniteQuery(() => ({
    queryKey: ["workspace-chats", data.spaceId],
    queryFn: async ({ pageParam }) => await listWorkspaceChats(data.spaceId, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
    select: (d) => {
      const seen = new Set<string>();
      return {
        chats: d.pages
          .flatMap((c) => c.chats)
          // Hide slack-sourced chats — those live in Slack, not in the sidebar.
          .filter((chat) => chat.source !== "slack")
          .filter((chat) => {
            if (seen.has(chat.id)) return false;
            seen.add(chat.id);
            return true;
          }),
      };
    },
    placeholderData: keepPreviousData,
  }));
</script>

<ChatProvider
  chatId={data.chatId}
  isNew={data.isNew}
  initialMessages={data.messages}
  artifacts={data.artifacts}
  apiEndpoint={workspaceChatApi}
  onPostSuccess={(id) =>
    goto(resolve(`/spaces/[spaceId]/chat/[chatId]`, { spaceId: data.spaceId, chatId: id }), {
      replaceState: false,
    })}
>
  {#snippet children(context)}
    <Page.Root>
      <Page.Content padded={false} {@attach scrollAttachment(data.isNew, context)}>
        {#snippet prepend()}
          <Breadcrumbs.Root fixed>
            <Breadcrumbs.Item href={appCtx.routes.spaces.item(data.spaceId)} showCaret>
              {#snippet prepend()}
                <Dot color={data.workspace.metadata?.color} />
              {/snippet}
              {data.workspace.name}
            </Breadcrumbs.Item>
          </Breadcrumbs.Root>
        {/snippet}

        {#if data.isNew && context.chat.messages.length === 0 && !initialPendingMessage}
          <div class="wrapper">
            <h1>Chat with {data.workspace.name}</h1>

            <div class="form-wrapper">
              <Form />
            </div>
          </div>
        {:else}
          <Messages />
          <Footer>
            <Form />
          </Footer>

          <ChatBufferBlur />
        {/if}
      </Page.Content>
      {#if data.isNew}
        <Page.Sidebar>
          <div>
            <h2>Conversations</h2>
            {#if workspaceChatsQuery.data?.chats?.length}
              <ul class="conversations">
                {#each workspaceChatsQuery.data?.chats ?? [] as chat (chat.id)}
                  <li>
                    <a
                      href="/spaces/{data.spaceId}/chat/{chat.id}"
                      class:active={data.chatId === chat.id}
                    >
                      {chat.title || "Untitled"}
                    </a>
                  </li>
                {/each}
              </ul>
            {:else}
              <span class="empty">You haven't chatted with this space before</span>
            {/if}
          </div>
        </Page.Sidebar>
      {/if}
    </Page.Root>
  {/snippet}
</ChatProvider>

<style>
  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    padding-block: var(--size-16) var(--size-4);
    text-align: center;
  }

  h2 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  .wrapper {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    margin-block-end: var(--size-32);
  }

  .form-wrapper {
    inline-size: 100%;
    margin: 0 auto;
    max-inline-size: var(--size-160);
    padding-inline: var(--size-8);
  }

  .conversations {
    & {
      margin-block: var(--size-2) 0;
    }

    a {
      align-items: center;
      block-size: var(--size-7);
      display: inline flex;
      font-weight: var(--font-weight-5);

      &:hover {
        text-decoration: underline;
      }

      &.active {
        opacity: 0.5;
      }
    }
  }
  .empty {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4);
    line-height: var(--font-lineheight-1);
    opacity: 0.6;
  }
</style>
