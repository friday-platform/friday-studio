<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { getAppContext } from "$lib/app-context.svelte";
  import { getChatContext } from "$lib/chat-context.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import AddWorkspaceDialog from "$lib/modules/spaces/add-workspace.svelte";
  import { listSpaces } from "$lib/queries/spaces";
  import { getActivePage } from "$lib/utils/active-page.svelte";
  import { GA4, trackEvent } from "@atlas/ga4";
  import { shareChat } from "$lib/utils/share-chat";
  import ScrollListener from "../scroll-listener.svelte";
  import NavigationControls from "./navigation-controls.svelte";

  const ctx = getAppContext();
  const chatContext = getChatContext();

  const query = createQuery(() => ({ queryKey: ["spaces"], queryFn: () => listSpaces() }));

  const currentChatId = $derived(page.params.chatId);
</script>

{#if __TAURI_BUILD__}
  <NavigationControls />
{/if}

<header class:is-app-sidebar={__TAURI_BUILD__}>
  <nav>
    {#if ctx.user && !__TAURI_BUILD__}
      <div class="user">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <span class="user-name">
              {ctx.user.display_name}

              <IconSmall.CaretDown />
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item
              href="/logout"
              data-sveltekit-reload
              onclick={() => trackEvent(GA4.LOGOUT_CLICK)}
            >
              Logout
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}

    <ul class="section-list">
      <li>
        <a
          href={ctx.routes.main}
          class:active={getActivePage("/")}
          class="sidebar-item"
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "chat" })}
        >
          <Icons.Chat />

          <span class="text">Chat</span>
        </a>
      </li>

      <li>
        <a
          href={ctx.routes.library.list}
          class:active={getActivePage(["library", "library/[id]"])}
          class="sidebar-item"
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "library" })}
        >
          <Icons.Folder />

          <span class="text">Library</span>
        </a>
      </li>

      <li>
        <a
          href={ctx.routes.sessions.list}
          class:active={getActivePage(["sessions", "sessions/[sessionId]"])}
          class="sidebar-item"
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "sessions" })}
        >
          <Icons.Workspace />

          <span class="text">Sessions</span>
        </a>
      </li>

      <li>
        <a
          href={ctx.routes.settings}
          class:active={getActivePage(["settings"])}
          class="sidebar-item"
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "settings" })}
        >
          <Icons.Settings />

          <span class="text">Settings</span>
        </a>
      </li>
    </ul>

    <span class="section-header">
      Spaces

      <AddWorkspaceDialog>
        {#snippet triggerContents()}
          <span class="section__add-new" aria-label="New Space"><IconSmall.Plus /></span>
        {/snippet}
      </AddWorkspaceDialog>
    </span>

    <div>
      {#if query.isSuccess}
        <ul class="section-list">
          {#each query.data as space (space.id)}
            <li>
              <a
                href={ctx.routes.spaces.item(space.id)}
                class="sidebar-item"
                class:active={getActivePage([`spaces/${space.id}`, `spaces/${space.id}/sessions`])}
                onclick={() => trackEvent(GA4.SPACE_CLICK, { space_id: space.id })}
              >
                <span class="text">{space.name}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <span class="section-header">
      Recent Chats

      <button
        class="section__add-new"
        onclick={() => {
          trackEvent(GA4.NEW_CHAT_CLICK, { source: "sidebar" });
          chatContext.startNewChat();
        }}
        aria-label="New Conversation"
      >
        <IconSmall.Plus />
      </button>
    </span>

    <ScrollListener
      requestLoadItems={() => chatContext.loadChats()}
      hasMoreItems={chatContext.hasMoreChats}
      cursor={chatContext.cursor}
      isFetching={chatContext.isFetching}
    >
      <ul class="section-list">
        {#each chatContext.recentChats as chat (chat.id)}
          <li class="chat-row">
            <a
              class="sidebar-item"
              class:active={currentChatId === chat.id}
              href="/chat/{chat.id}"
              onclick={() => trackEvent(GA4.RECENT_CHAT_CLICK, { chat_id: chat.id })}
            >
              <span class="text">{chat.title || "Untitled"}</span>
            </a>

            <div class="chat-options">
              <DropdownMenu.Root positioning={{ placement: "bottom" }}>
                <DropdownMenu.Trigger aria-label="Chat options">
                  <div class="chat-trigger">
                    <Icons.TripleDots />
                  </div>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Item
                    onclick={async () => {
                      trackEvent(GA4.SHARE_CHAT_CLICK, { chat_id: chat.id, source: "sidebar" });
                      const res = await parseResult(
                        client.chat[":chatId"].$get({ param: { chatId: chat.id } }),
                      );

                      if (res.ok) {
                        // @ts-expect-error the type is correct
                        await shareChat(res.data.messages, chat.title ?? "Untitled");
                      }
                    }}
                  >
                    <Icons.Share />

                    Share
                  </DropdownMenu.Item>

                  <Dialog.Root>
                    {#snippet children(open)}
                      <DropdownMenu.Item
                        accent="destructive"
                        onclick={() => {
                          trackEvent(GA4.DELETE_CHAT_CLICK, { chat_id: chat.id });
                          open.set(true);
                        }}
                      >
                        <Icons.Trash />
                        Delete
                      </DropdownMenu.Item>

                      <Dialog.Content>
                        <Dialog.Close />

                        {#snippet icon()}
                          <span style:color="var(--color-red)">
                            <Icons.DeleteSpace />
                          </span>
                        {/snippet}

                        {#snippet header()}
                          <Dialog.Title>Delete Conversation</Dialog.Title>
                          <Dialog.Description>
                            <p>
                              Shared conversations may be available for up to 90 days after being
                              deleted.
                            </p>
                          </Dialog.Description>
                        {/snippet}

                        {#snippet footer()}
                          <Dialog.Button
                            onclick={async () => {
                              trackEvent(GA4.DELETE_CHAT_CONFIRM, { chat_id: chat.id });
                              const res = await parseResult(
                                client.chat[":chatId"].$delete({ param: { chatId: chat.id } }),
                              );
                              if (res.ok) {
                                await chatContext.loadChats({ reset: true });
                                if (currentChatId === chat.id) {
                                  chatContext.startNewChat();
                                }
                              }
                            }}
                          >
                            Confirm
                          </Dialog.Button>

                          <Dialog.Cancel>Cancel</Dialog.Cancel>
                        {/snippet}
                      </Dialog.Content>
                    {/snippet}
                  </Dialog.Root>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </li>
        {/each}
      </ul>
    </ScrollListener>
  </nav>

  <a
    href="https://docs.hellofriday.ai"
    target="_blank"
    class="help"
    aria-label="Get Help"
    onclick={() => trackEvent(GA4.HELP_CLICK)}
  >
    ?
  </a>
</header>

<style>
  header {
    background-color: var(--color-surface-2);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--size-4);
    padding-block: var(--size-5);
    padding-inline: var(--size-3);
    position: relative;
    overflow-y: auto;
    scrollbar-width: none;
    transform: translate3d(0, 0, 0);
    z-index: var(--layer-1);

    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;

    &.is-app-sidebar {
      padding-block: var(--size-13) var(--size-5);
    }
  }

  .user {
    padding-inline: var(--size-2-5);
    margin-block: var(--size-1) var(--size-6);

    .user-name {
      align-items: center;
      display: flex;
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
    }
  }

  ul {
    display: flex;
    flex-direction: column;

    li {
      inline-size: 100%;
    }
  }

  .sidebar-item {
    align-items: center;
    block-size: var(--size-7);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-2);
    /* padding-inline: var(--size-7); */
    outline: none;

    & :global(svg) {
      color: var(--accent-1);
      flex: none;
      opacity: 0.5;
    }

    .text {
      opacity: 0.8;
    }

    &.active,
    &:focus-visible {
      background-color: var(--color-highlight-1);
    }
  }

  .section-header {
    border-block-start: var(--size-px) solid var(--color-border-1);
    block-size: var(--size-9);
    display: flex;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    justify-content: space-between;
    padding-block: var(--size-3) var(--size-1-5);
    padding-inline: var(--size-2-5);

    .section__add-new {
      align-items: center;
      background-color: var(--color-surface-1);
      border-radius: var(--radius-round);
      block-size: var(--size-4);
      box-shadow: var(--shadow-1);
      inline-size: var(--size-4);
      display: flex;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      margin-inline-end: calc(-1 * var(--size-1));

      &,
      & :global(svg) {
        transition: transform 200ms ease-in;
      }

      &:hover {
        transform: rotate(-90deg) scale(1.14);

        & :global(svg) {
          transform: scale(0.86);
        }
      }

      :global(:focus-visible) &,
      &:matches(button):focus-visible {
        outline: var(--size-px) solid color-mix(in srgb, var(--color-text), transparent 50%);
      }
    }
  }

  .section-list {
    padding-block-end: var(--size-2);

    a {
      padding-inline: var(--size-2-5) var(--size-2);

      span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }

  .chat-row {
    display: flex;
    align-items: center;
    gap: var(--size-1);
    position: relative;

    .sidebar-item {
      flex: 1;
      min-inline-size: 0;
    }

    .chat-options {
      align-items: center;
      block-size: var(--size-7);
      display: flex;
      inline-size: var(--size-7);
      inset-inline-end: 0;
      inset-block-start: 0;
      justify-content: center;
      position: absolute;
      transform: translate3d(0, 0, 0);
    }

    .chat-trigger {
      align-items: center;
      border-radius: var(--radius-3);
      block-size: var(--size-6);
      display: flex;
      inline-size: var(--size-6);
      justify-content: center;
      opacity: 0;
      transition: all 0.2s ease;
      visibility: hidden;
    }
  }

  .chat-row:hover .chat-trigger,
  :global(:focus-visible) .chat-trigger,
  :global([data-state="open"]) .chat-trigger {
    opacity: 1;
    visibility: visible;
  }

  .chat-trigger:hover,
  :global(:focus-visible) .chat-trigger {
    background-color: var(--color-border-1);
  }

  .help {
    align-items: center;
    background-color: var(--color-surface-1);
    block-size: var(--size-7);
    border-radius: var(--radius-round);
    box-shadow: var(--shadow-1);
    color: var(--text-1);
    display: flex;
    flex: none;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-7);
    inline-size: var(--size-7);
    inset-block-end: 0;
    justify-content: center;
    margin-block: auto 0;
    margin-inline: var(--size-2) 0;
    position: sticky;
    transition: all 150ms ease;
  }
</style>
