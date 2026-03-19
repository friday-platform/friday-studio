<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import {
    createInfiniteQuery,
    createQuery,
    keepPreviousData,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Collapsible } from "$lib/components/collapsible";
  import { Dialog } from "$lib/components/dialog";
  import Dot from "$lib/components/dot.svelte";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import {
    getActivityUnreadCount,
    startActivityStream,
  } from "$lib/modules/activity/activity-stream.svelte";
  import AddWorkspaceDialog from "$lib/modules/spaces/add-workspace.svelte";
  import { listChats } from "$lib/queries/chats";
  import { listSpaces } from "$lib/queries/spaces";
  import { getActivePage, getActiveParam } from "$lib/utils/active-page.svelte";
  import { shareChat } from "$lib/utils/share-chat";
  import { onMount } from "svelte";
  import ScrollListener from "../scroll-listener.svelte";
  import Usage from "./usage.svelte";

  const ctx = getAppContext();
  const queryClient = useQueryClient();

  const query = createQuery(() => ({ queryKey: ["spaces"], queryFn: () => listSpaces() }));
  const chatsQuery = createInfiniteQuery(() => ({
    queryKey: ["chats"],
    queryFn: async ({ pageParam }) => await listChats(pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
    select: (data) => {
      const seen = new Set<string>();
      const chats = data.pages
        .flatMap((c) => c.chats)
        .filter((chat) => {
          if (chat.source !== "atlas" || seen.has(chat.id)) return false;
          seen.add(chat.id);
          return true;
        });
      return { chats, cursor: data.pages.at(-1)?.nextCursor, hasMore: data.pages.at(-1)?.hasMore };
    },
    placeholderData: keepPreviousData,
  }));

  onMount(() => {
    startActivityStream();
  });

  const currentChatId = $derived(page.params.chatId);
</script>

<header>
  <nav>
    {#if ctx.user}
      <div class="user">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <span class="user-name">
              {ctx.user.display_name ?? ctx.user.full_name ?? ctx.user.email}

              <IconSmall.CaretDown />
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item
              href={ctx.routes.settings}
              data-sveltekit-reload
              onclick={() => trackEvent(GA4.NAV_CLICK, { section: "settings" })}
            >
              Settings
            </DropdownMenu.Item>

            <DropdownMenu.Separator />

            <DropdownMenu.Item
              href="/logout"
              data-sveltekit-reload
              onclick={() => trackEvent(GA4.LOGOUT_CLICK)}
            >
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}

    <ul class="main-links">
      <li>
        <a
          href={ctx.routes.library.list}
          class:active={getActivePage(["library", "library/[id]"])}
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "library" })}
        >
          <IconSmall.Library />
          Library
        </a>
      </li>

      <li>
        <a
          href={ctx.routes.activity.list}
          class:active={getActivePage(["(app)/activity"])}
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "activity" })}
        >
          <IconSmall.Activity />
          Activity

          {#if getActivityUnreadCount() > 0 && !getActivePage( ["(app)/activity", "(app)/sessions/[sessionId]"], )}
            <span class="badge">{getActivityUnreadCount()}</span>
          {/if}
        </a>
      </li>

      <li>
        <a
          href={ctx.routes.skills.list}
          class:active={getActivePage(["(app)/skills", "(app)/skills/[skillId]"])}
          onclick={() => trackEvent(GA4.NAV_CLICK, { section: "skills" })}
        >
          <IconSmall.Skills />
          Skills
        </a>
      </li>
    </ul>

    <Collapsible.Root defaultOpen>
      <Collapsible.Trigger>
        <span class="section-trigger">
          Spaces <IconSmall.TriangleDown />
        </span>
      </Collapsible.Trigger>

      <Collapsible.Content animate>
        <ul class="section-list">
          {#if query.isSuccess}
            {#each query.data as space (space.id)}
              {@const active = getActiveParam("spaceId", space.id)}
              <li>
                <a
                  href={ctx.routes.spaces.item(space.id)}
                  class:active
                  onclick={() => trackEvent(GA4.SPACE_CLICK, { space_id: space.id })}
                >
                  <Dot color={space.metadata?.color} />
                  <span class="text">{space.name}</span>
                </a>

                {#if active}
                  <ul class="sub-nav">
                    <li>
                      <a
                        href={ctx.routes.spaces.item(space.id, "chat")}
                        class:active={getActivePage(["chat/[[chatId]]"])}
                      >
                        Conversations
                      </a>
                    </li>
                  </ul>
                {/if}
              </li>
            {/each}
          {/if}

          <li>
            <AddWorkspaceDialog>
              {#snippet triggerContents()}
                <span class="as-button" aria-label="New Conversation">
                  <IconSmall.Workspace />
                  Add Space
                </span>
              {/snippet}
            </AddWorkspaceDialog>
          </li>
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>

    <ScrollListener
      requestLoadItems={() => chatsQuery.fetchNextPage()}
      hasMoreItems={chatsQuery.hasNextPage}
      cursor={chatsQuery.data?.cursor}
      isFetching={chatsQuery.isFetching}
    >
      <Collapsible.Root defaultOpen>
        <Collapsible.Trigger>
          <span class="section-trigger">
            Conversations <IconSmall.TriangleDown />
          </span>
        </Collapsible.Trigger>

        <Collapsible.Content animate>
          <ul class="section-list">
            <li>
              <button
                class:active={getActivePage(["(app)/chat/[[chatId]]"]) &&
                  !("chatId" in page.params)}
                onclick={() => {
                  trackEvent(GA4.NEW_CHAT_CLICK, { source: "sidebar" });
                  goto("/chat");
                }}
                aria-label="New Conversation"
              >
                <IconSmall.Chat />
                New conversation
              </button>
            </li>

            {#if chatsQuery.isSuccess}
              {#each chatsQuery.data.chats as chat (chat.id)}
                <li class="chat-row">
                  <a
                    class="sidebar-item"
                    class:active={getActivePage(["(app)/chat/[[chatId]]"]) &&
                      currentChatId === chat.id}
                    href="/chat/{chat.id}"
                    onclick={(e) => {
                      if (currentChatId === chat.id) {
                        e.preventDefault();
                      } else {
                        trackEvent(GA4.RECENT_CHAT_CLICK, { chat_id: chat.id });
                      }
                    }}
                  >
                    <span class="text">{chat.title || "Untitled"}</span>
                  </a>

                  <div class="chat-options">
                    <DropdownMenu.Root
                      positioning={{
                        placement: "right-start",
                        gutter: 0,
                        offset: { mainAxis: 12, crossAxis: -8 },
                      }}
                    >
                      <DropdownMenu.Trigger aria-label="Chat options">
                        <div class="chat-trigger">
                          <Icons.TripleDots />
                        </div>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          onclick={async () => {
                            trackEvent(GA4.SHARE_CHAT_CLICK, {
                              chat_id: chat.id,
                              source: "sidebar",
                            });
                            const res = await parseResult(
                              client.chat[":chatId"].$get({ param: { chatId: chat.id } }),
                            );

                            if (res.ok) {
                              // @ts-expect-error the type is correct
                              await shareChat(
                                res.data.messages,
                                chat.title ?? "Untitled",
                                chat.color,
                              );
                            }
                          }}
                        >
                          {#snippet prepend()}
                            <Icons.Share />
                          {/snippet}

                          Share
                        </DropdownMenu.Item>

                        <Dialog.Root>
                          {#snippet children(open)}
                            <DropdownMenu.Item
                              onclick={() => {
                                trackEvent(GA4.DELETE_CHAT_CLICK, { chat_id: chat.id });
                                open.set(true);
                              }}
                            >
                              {#snippet prepend()}
                                <Icons.Trash />
                              {/snippet}
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
                                <Dialog.Title>Delete conversation</Dialog.Title>
                                <Dialog.Description>
                                  <p>
                                    Shared conversations may be available for up to 90 days after
                                    being deleted.
                                  </p>
                                </Dialog.Description>
                              {/snippet}

                              {#snippet footer()}
                                <Dialog.Button
                                  onclick={async () => {
                                    trackEvent(GA4.DELETE_CHAT_CONFIRM, { chat_id: chat.id });
                                    const res = await parseResult(
                                      client.chat[":chatId"].$delete({
                                        param: { chatId: chat.id },
                                      }),
                                    );
                                    if (res.ok) {
                                      await queryClient.invalidateQueries({
                                        queryKey: ["chats"],
                                        refetchType: "all",
                                      });
                                      if (currentChatId === chat.id) {
                                        goto("/chat");
                                      }
                                    }
                                  }}
                                >
                                  Delete
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
            {/if}
          </ul>
        </Collapsible.Content>
      </Collapsible.Root>
    </ScrollListener>
  </nav>

  <div class="footer">
    <Usage />

    <a
      href="https://docs.hellofriday.ai"
      target="_blank"
      class="help"
      aria-label="Get Help"
      onclick={() => trackEvent(GA4.HELP_CLICK)}
    >
      ?
    </a>
  </div>
</header>

<style>
  header {
    background-color: var(--color-surface-2);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--size-4);
    padding-block: var(--size-5) 0;
    padding-inline: var(--size-3);
    position: relative;
    overflow-y: auto;
    scrollbar-width: none;
    transform: translate3d(0, 0, 0);
    z-index: var(--layer-1);

    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
  }

  .user {
    padding-inline: var(--size-2-5);
    margin-block: var(--size-1) 0;

    .user-name {
      align-items: center;
      display: flex;
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
    }
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-inline: var(--size-1);

    &.main-links {
      gap: 0;
    }

    .badge {
      align-items: center;
      background-color: color-mix(in srgb, var(--color-text), transparent 92%);
      border-radius: var(--radius-round);
      block-size: var(--size-5-5);
      display: flex;
      justify-content: center;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      margin-inline-start: auto;
      margin-inline-end: calc(-1 * var(--size-2));
      min-inline-size: var(--size-7-5);
      padding-inline: var(--size-2);
      text-align: center;
    }

    li {
      inline-size: 100%;
    }

    a,
    button,
    .as-button {
      align-items: center;
      block-size: var(--size-6);
      border-radius: var(--radius-2);
      color: color-mix(in srgb, var(--color-text), transparent 20%);
      display: flex;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
      inline-size: 100%;
      outline: none;
      padding-inline: var(--size-2-5) var(--size-2);
      position: relative;

      & :global(svg) {
        opacity: 0.5;
      }

      .text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        text-wrap: nowrap;
      }

      &.active,
      &:focus-visible {
        background-color: hsl(0 0 0% / 0.05);

        & :global(svg) {
          color: var(--blue-2);
          opacity: 1;
        }

        @media (prefers-color-scheme: dark) {
          background-color: hsl(0 0 100% / 0.05);
        }
      }
    }
  }

  .sub-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    margin-block-start: var(--size-0-5);

    a {
      font-weight: var(--font-weight-4);
      padding-inline-start: var(--size-7);

      &.active,
      &:focus-visible {
        background-color: unset;
        text-decoration: underline;

        @media (prefers-color-scheme: dark) {
          background-color: unset;
        }
      }
    }
  }

  .section-trigger {
    block-size: var(--size-4);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
    padding-inline: var(--size-3);
    margin-block-end: var(--size-1);

    :global(svg) {
      transform: rotate(-90deg);
      transition: transform 150ms ease;
    }
  }

  :global([data-melt-collapsible-trigger][data-state="open"]) .section-trigger :global(svg) {
    transform: rotate(0deg);
  }

  .section-list {
    padding-block-end: var(--size-2);
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
      border-radius: var(--radius-2);
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
  :global([data-melt-dropdown-menu-trigger][data-state="open"]) .chat-trigger {
    opacity: 1;
    visibility: visible;
  }

  .chat-trigger:hover,
  :global(:focus-visible) .chat-trigger {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }

  .sidebar-item.active + .chat-options .chat-trigger:hover {
    background-color: transparent;
  }

  .footer {
    background-color: var(--color-surface-2);
    inset-block-end: 0;
    margin-inline: var(--size-2) 0;
    margin-block: auto 0;
    padding-block: 0 var(--size-5);
    position: sticky;
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
    justify-content: center;
    transition: all 150ms ease;
  }
</style>
