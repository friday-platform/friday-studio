<script lang="ts">
import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { onMount } from "svelte";
import { page } from "$app/state";
import { getAppContext } from "$lib/app-context.svelte";
import logo from "$lib/assets/logo.png";
import { getChatContext } from "$lib/chat-context.svelte";
import { Dialog } from "$lib/components/dialog";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import AddWorkspaceDialog from "$lib/modules/spaces/add-workspace.svelte";
import { getActivePage } from "$lib/utils/active-page.svelte";
import { shareChat } from "$lib/utils/share-chat";
import ScrollListener from "../scroll-listener.svelte";
import ExpandDecal from "./expand-decal.svelte";
import NavigationControls from "./navigation-controls.svelte";

type WorkspacesListResponse = InferResponseType<typeof client.workspace.index.$get, 200>;

const ctx = getAppContext();
const chatContext = getChatContext();
let spaces = $state<WorkspacesListResponse>([]);

const currentChatId = $derived(page.params.chatId);

let mounted = $state(false);
let isDesktop = $state(__TAURI_BUILD__);

async function loadSpaces() {
  try {
    const res = await parseResult(client.workspace.index.$get());
    if (!res.ok) {
      console.error("Failed to load spaces:", res.error);
      spaces = [];
      return;
    }
    const allSpaces = res.data;
    spaces = allSpaces.filter(
      (w) => w.name !== "atlas-conversation" && !w.path.includes("/examples/"),
    );
  } catch (error) {
    console.error("Failed to load spaces:", error);
    spaces = [];
  }
}

onMount(() => {
  mounted = true;
  if (typeof window !== "undefined" && "__TAURI__" in window) {
    isDesktop = true;
  }
  loadSpaces();
  ctx.setWorkspacesRefreshCallback(loadSpaces);
});
</script>

{#if __TAURI_BUILD__ && ctx.sidebarExpanded}
	<NavigationControls />
{/if}

<header class:expanded={ctx.sidebarExpanded} class:mounted>
	{#if !ctx.sidebarExpanded}
		<a href={ctx.routes.main} class="logo" aria-label="Altas">
			<img src={logo} alt="Altas" />
		</a>
		<button
			class="expand-sidebar"
			onclick={() => {
				ctx.sidebarExpanded = true;
			}}
		>
			<span class="arrow"><IconSmall.CaretRight /></span>
			<span class="label"><ExpandDecal /></span>
		</button>
	{/if}

	{#if ctx.sidebarExpanded}
		<nav>
			<ul class="section-list">
				<li>
					<a href={ctx.routes.main} class:active={getActivePage('/')} class="sidebar-item">
						<Icons.Chat />

						<span class="text">Chat</span>
					</a>
				</li>

				<li>
					<a
						href={ctx.routes.library.list}
						class:active={getActivePage(['library', 'library/[id]'])}
						class="sidebar-item"
					>
						<Icons.Folder />

						<span class="text">Library</span>
					</a>
				</li>

				<li>
					<a
						href={ctx.routes.sessions.list}
						class:active={getActivePage(['sessions', 'sessions/[sessionId]'])}
						class="sidebar-item"
					>
						<Icons.Workspace />

						<span class="text">Sessions</span>
					</a>
				</li>

				<li>
					<a
						href={ctx.routes.settings}
						class:active={getActivePage(['settings'])}
						class="sidebar-item"
					>
						<Icons.Settings />

						<span class="text">Settings</span>
					</a>
				</li>

				{#if !isDesktop}
					<li>
						<a href="/logout" class="sidebar-item">
							<Icons.LogOut />

							<span class="text">Logout</span>
						</a>
					</li>
				{/if}
			</ul>

			<span class="section-header">
				Spaces

				<AddWorkspaceDialog>
					{#snippet triggerContents()}
						<span class="section__add-new" aria-label="New Space"> <IconSmall.Plus /> </span>
					{/snippet}
				</AddWorkspaceDialog>
			</span>

			<ul class="section-list">
				{#each spaces as space (space.id)}
					<li>
						<a
							href={ctx.routes.spaces.item(space.id)}
							class="sidebar-item"
							class:active={getActivePage([`spaces/${space.id}`, `spaces/${space.id}/sessions`])}
						>
							<span class="text">{space.name}</span>
						</a>
					</li>
				{/each}
			</ul>

			<span class="section-header">
				Recent Chats

				<button
					class="section__add-new"
					onclick={() => {
						chatContext.resetNewChat();
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
							>
								<span class="text">{chat.title || 'Untitled'}</span>
							</a>

							<div class="chat-options">
								<DropdownMenu.Root
									positioning={{
										placement: 'bottom'
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
												const res = await parseResult(
													client.chat[':chatId'].$get({ param: { chatId: chat.id } })
												);

												if (res.ok) {
													// @ts-expect-error the type is correct
													await shareChat(res.data.messages, chat.title ?? 'Untitled');
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
																const res = await parseResult(
																	client.chat[':chatId'].$delete({ param: { chatId: chat.id } })
																);
																if (res.ok) {
																	await chatContext.loadChats({ reset: true });
																	if (currentChatId === chat.id) {
																		chatContext.resetNewChat();
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
	{/if}

	<a href="https://discord.gg/Mx5YFWmDuJ" target="_blank" class="help" aria-label="Get Help"> ? </a>
</header>

<style>
	header {
		background-color: var(--color-surface-2);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: var(--size-4);
		padding-block: var(--size-13) var(--size-5);
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
		padding-inline: var(--size-2);
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
			background-color: color-mix(in srgb, var(--color-border-1) 80%, transparent);
		}
	}

	.logo {
		align-items: center;
		background-color: #181c2f;
		block-size: var(--size-8);
		border-radius: var(--radius-3);
		color: #fff;
		display: flex;
		inline-size: var(--size-8);
		justify-content: center;
		margin-inline: auto;
		mix-blend-mode: exclusion;
		transition: all 150ms ease;

		img {
			block-size: var(--size-4-5);
		}
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
		margin-block: auto var(--size-1);
		margin-inline: var(--size-5) 0;
		position: sticky;
		transition: all 150ms ease;
	}

	.expanded .help {
		margin-block-end: 0;
		margin-inline: var(--size-2) 0;
	}

	.expand-sidebar {
		background-color: var(--color-surface-1);
		border: 1px solid var(--color-border-1);
		border-inline-end: none;
		border-radius: var(--radius-round);
		border-start-end-radius: 0;
		border-end-end-radius: 0;
		block-size: var(--size-6);
		color: var(--color-yellow);
		display: flex;
		justify-content: center;
		align-items: center;
		inline-size: var(--size-5-5);
		padding-inline-start: var(--size-1-5);
		position: absolute;
		inset-inline-end: -1px;
		inset-block-start: 50%;
		transform: translateY(-50%);
		transition: all 0.2s ease-in-out;

		.arrow {
			flex: none;
		}

		.label {
			clip-path: circle(0px at 0 20px);
			position: absolute;
			inset-inline-start: calc(-1 * var(--size-3));
			inset-block-start: 50%;
			transform: scale(0.9) translateY(-50%);
			transform-origin: left top;
			transition: all 0.2s ease-in-out;
		}

		&:hover {
			& {
				inline-size: var(--size-6);
			}

			.label {
				clip-path: circle(40px at 0 20px);
				transform: scale(1) translateY(-50%);
			}
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
	:global([data-state='open']) .chat-trigger {
		opacity: 1;
		visibility: visible;
	}

	.chat-trigger:hover,
	:global(:focus-visible) .chat-trigger {
		background-color: var(--color-border-1);
	}
</style>
