<script lang="ts">
import { Chat } from "@ai-sdk/svelte";
import { type AtlasUIMessage, type AtlasUIMessagePart } from "@atlas/agent-sdk";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { DefaultChatTransport } from "ai";
import { onMount } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { z } from "zod";
import { afterNavigate } from "$app/navigation";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { getChatContext } from "$lib/chat-context.svelte";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
import Outline from "$lib/modules/conversation/outline.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Progress from "$lib/modules/messages/progress.svelte";
import Reasoning from "$lib/modules/messages/reasoning.svelte";
import Request from "$lib/modules/messages/request.svelte";
import Response from "$lib/modules/messages/response.svelte";
import ShowDetails from "$lib/modules/messages/show-details.svelte";
import { shareChat } from "$lib/utils/share-chat";
import { invoke } from "$lib/utils/tauri-loader";
import type { PageData } from "./$types";

const { data }: { data: PageData } = $props();

const appCtx = getAppContext();
const chatContext = getChatContext();

let chat = $state<Chat<AtlasUIMessage>>();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");

// Follow scroll handling
let scrollContainer = $state<HTMLDivElement | null>(null);

function setup() {
  if (chatContext.chats.has(data.chatId)) {
    chat = chatContext.chats.get(data.chatId);
  } else {
    chat = new Chat({
      id: data.chatId,
      messages: data.messages,
      onFinish: () => {
        scrollToBottom();
      },
      transport: new DefaultChatTransport({
        api: `${getAtlasDaemonUrl()}/api/chat`,
        prepareSendMessagesRequest({ messages, id }) {
          return { body: { message: messages.at(-1), id } };
        },
      }),
    });

    chatContext.chats.set(data.chatId, chat);
  }
}

afterNavigate(setup);
onMount(setup);

let _userHasScrolled = $state(false);

// Handle Scrolling
function handleScroll() {
  _userHasScrolled = true;

  if (!scrollContainer) return;

  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 5;

  // If user scrolls away from bottom, mark as manually scrolled
  if (!isAtBottom) {
    _userHasScrolled = true;
  }
  // If user scrolls back to bottom, reset the flag
  if (isAtBottom) {
    _userHasScrolled = false;
  }
}

// Scroll to the bottom of the container
function scrollToBottom() {
  if (!scrollContainer) return;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

let actionsAfterLastUser = $state<{ parts: AtlasUIMessagePart[]; timestamp?: string }>({
  parts: [],
});

$effect(() => {
  const lastAssistantMessage = (chat?.messages ?? []).findLast((msg) => msg.role === "assistant");

  // If no user message found, return empty
  if (!lastAssistantMessage) {
    actionsAfterLastUser = { parts: [] };
    return;
  }

  // Return everything after the last user message
  actionsAfterLastUser = {
    parts: lastAssistantMessage.parts,
    timestamp: lastAssistantMessage.metadata?.startTimestamp,
  };
});

let showDetails = new SvelteMap<string, boolean>();
</script>

{#if chat}
	<div class="chat">
		<div class="main">
			<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
				<div
					class="messages-container"
					class:has-outline={chat.messages.some((msg) =>
						msg.parts.some((part) => part.type === 'data-outline-update')
					)}
				>
					<div class="messages-inner">
						<div class="first-message">
							<h2>{data.title ?? 'Untitled'}</h2>
						</div>

						{#each chat.messages as messageContainer, index ((messageContainer.id, index))}
							{@const messages = messageContainer.parts
								.map((message) => formatMessage(messageContainer, message))
								.filter((part) => part !== undefined)}

							{#if messages.length > 0}
								<div class="message-parts">
									{#each messages as message, index (index)}
										{#if message}
											{#if message.type === 'request'}
												<Request {message} />
											{:else if message.type === 'text'}
												<Response {message} parts={messageContainer.parts} />
											{:else if message.type === 'tool_call' && message.metadata?.toolName === 'display_artifact' && message.metadata?.artifactId}
												<DisplayArtifact artifactId={message.metadata.artifactId as string} />
											{:else if message.type === 'error'}
												<ErrorMessage {message} />
											{/if}
										{/if}
									{/each}

									{#if messageContainer.role === 'assistant' && messageContainer.parts.some((part) => part.type === 'text' && part.state === 'done')}
										<div class="show-details" class:open={showDetails.get(messageContainer.id)}>
											<ShowDetails
												open={showDetails.get(messageContainer.id) ?? false}
												onclick={() => {
													const status = showDetails.get(messageContainer.id) ?? false;

													showDetails.set(messageContainer.id, !status);
												}}
											/>
										</div>
									{/if}

									{#if showDetails.get(messageContainer.id)}
										<Reasoning parts={messageContainer.parts} />
									{/if}
								</div>
							{/if}
						{/each}

						{#if chat.status === 'streaming' || chat.status === 'submitted'}
							<Progress
								actions={actionsAfterLastUser.parts}
								timestamp={actionsAfterLastUser.timestamp}
							/>
						{/if}
					</div>

					<Outline
						messages={(chat.messages ?? [])
							.filter((msg) => msg.role === 'assistant')
							.filter((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
					/>
				</div>

				<div class="spacer"></div>

				<div
					class="interactive-container"
					class:has-outline={chat.messages.some((msg) =>
						msg.parts.some((part) => part.type === 'data-outline-update')
					)}
				>
					<div class="interactive-container-int">
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<form
							bind:this={form}
							onkeydown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
									e.preventDefault();
									e.currentTarget?.requestSubmit();
								}
							}}
							onsubmit={async (e) => {
								e.preventDefault();

								if (chat && message.trim()) {
									let combinedMessage = message;
									if (appCtx.stagedFiles.state.size > 0) {
										combinedMessage = combinedMessage + `\n\nAttachments:`;

										for (const id of appCtx.stagedFiles.state.keys()) {
											combinedMessage = combinedMessage + `\n- ${id}`;
										}
									}

									chat.sendMessage({ text: combinedMessage });
									message = '';
									appCtx.stagedFiles.clear();
								}

								try {
									const formData = new FormData(e.target as HTMLFormElement);
									let formMessage = formData.get('message');

									if (appCtx.stagedFiles.state.size > 0) {
										formMessage = formMessage + `\n\nAttachments:`;

										for (const id of appCtx.stagedFiles.state.keys()) {
											formMessage = formMessage + `\n- ${id}`;
										}
									}

									const { data: sanitizedMessage } = z.string().safeParse(formMessage);

									if (!sanitizedMessage || sanitizedMessage.trim().length === 0) return;

									_userHasScrolled = false;
									scrollToBottom();
								} catch (e) {
									console.error(e);
								}
							}}
						>
							{#if appCtx.stagedFiles.state.size > 0}
								<div class="staged-files">
									{#each appCtx.stagedFiles.state.entries() as [itemId, file] (itemId)}
										<button
											title={file.path}
											onclick={async () => {
												appCtx.stagedFiles.remove(itemId);
											}}
										>
											{#if file.type === 'file'}
												<IconSmall.File />
											{:else}
												<IconSmall.Folder />
											{/if}

											<span class="file-path">{file.name}</span>

											<span class="close-button">
												<IconSmall.Close />
											</span>
										</button>
									{/each}
								</div>
							{/if}

							<div class="textarea-container">
								{#if __TAURI_BUILD__}
									<div class="actions">
										<DropdownMenu.Root
											positioning={{
												placement: 'bottom-start',
												gutter: 0,
												offset: { crossAxis: -6, mainAxis: 12 }
											}}
										>
											<DropdownMenu.Trigger>
												<div class="action-trigger">
													<Icons.Plus />
												</div>
											</DropdownMenu.Trigger>
											<DropdownMenu.Content size="regular">
												<DropdownMenu.Item
													onclick={async (e) => {
														e.preventDefault();

														if (invoke) {
															try {
																const paths = (await invoke('open_file_or_folder_picker', {
																	multiple: true,
																	foldersOnly: false
																})) as string[];

																if (paths && paths.length > 0) {
																	for (const path of paths) {
																		appCtx.stagedFiles.add(path, {
																			path,
																			type: getFileType(path)
																		});
																	}
																}
															} catch (error) {
																console.error('Failed to open file picker:', error);
															}
														}
													}}
												>
													<Icons.Paperclip />

													Add Files
												</DropdownMenu.Item>

												<DropdownMenu.Item
													onclick={async () => {
														if (chat?.messages) {
															await shareChat(chat.messages, data.title);
														}
													}}
												>
													<Icons.Share />

													Share
												</DropdownMenu.Item>

												<DropdownMenu.Item
													onclick={() => {
														chatContext.resetNewChat();
													}}
												>
													<Icons.Chat />
													New Chat
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</div>
								{/if}

								<Textarea
									name="message"
									placeholder="Type here..."
									value={message}
									onTextChange={(value) => {
										message = value;
									}}
								/>

								<div class="form-action">
									{#if chat.status === 'streaming' || chat.status === 'submitted'}
										<button
											class="stop-process"
											type="button"
											onclick={async (e) => {
												e.preventDefault();

												chat?.stop();
											}}
										>
											<IconSmall.Stop />
										</button>
									{:else}
										<button type="submit" aria-label="Send message">
											<Icons.ArrowUp />
										</button>
									{/if}
								</div>
							</div>
						</form>
					</div>
				</div>

				<div class="background-blur"></div>
			</div>
		</div>
	</div>
{/if}

<style>
	.chat {
		block-size: 100%;
		display: grid;
		grid-template-columns: 1fr;
		inline-size: 100%;
		overflow: hidden;
		position: relative;
		z-index: var(--layer-0);
	}

	.main {
		display: flex;
		block-size: 100%;
		overflow: hidden;
		flex-direction: column;
		position: relative;
	}

	.first-message {
		h2 {
			font-size: var(--font-size-8);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
			margin-block-end: var(--size-2);
		}
	}

	.messages {
		block-size: 100%;
		display: flex;
		flex-direction: column;
		overflow-y: scroll;
		scroll-padding: 100px;
		justify-content: end;
		padding-block: 0 var(--size-16);
		position: relative;
		scrollbar-width: thin;
		scroll-behavior: smooth;
	}

	.background-blur {
		background: linear-gradient(to top, var(--color-surface-1) 75%, transparent);
		block-size: 5.5625rem;
		inset-block-end: 0;
		inset-inline: 0;
		position: fixed;
		opacity: 1;
		pointer-events: none;
		z-index: var(--layer-1);
	}

	.spacer {
		flex: 1;
	}

	.messages-container {
		display: grid;
		grid-template-columns: 1fr 0;
		gap: 0;
		padding-block: var(--size-10) var(--size-16);
		transition:
			grid-template-columns 450ms ease-in-out,
			gap 450ms ease-in-out;

		&.has-outline {
			grid-template-columns: 1fr var(--size-56);
		}
	}

	.message-parts {
		display: flex;
		flex-direction: column;
		inline-size: 100%;
		gap: var(--size-4);
	}

	.show-details {
		opacity: 0;
		visibility: hidden;
		transition: opacity 250ms ease;
	}

	.message-parts:hover .show-details,
	.show-details.open {
		opacity: 1;
		visibility: visible;
	}

	.messages-inner {
		display: flex;
		flex-direction: column;
		inline-size: 100%;
		gap: var(--size-8);
		margin: 0 auto;
		max-inline-size: var(--size-272);
		overflow: hidden;
		padding-inline: var(--size-16);
	}

	.interactive-container {
		--local__translate-y: var(--size-4);
		inset-block-end: var(--size-16);
		inset-inline-start: calc(var(--size-56));
		inset-inline-end: var(--size-16);
		position: fixed;
		transition: all 450ms ease-in-out;
		z-index: var(--layer-2);

		&.has-outline {
			inset-inline-end: calc(var(--size-56));
		}

		.interactive-container-int {
			margin-inline: auto;
			max-inline-size: var(--size-272);
			padding-inline: var(--size-16);
		}

		form {
			background-color: var(--color-surface-1);
			border-radius: var(--radius-5);
			box-shadow: var(--shadow-1);
			display: flex;
			flex-direction: column;
			position: relative;
			padding-inline: var(--size-3) var(--size-1-5);

			.form-action {
				display: flex;
				margin-block-end: var(--size-1-5);
			}

			button[type='submit'],
			.stop-process {
				align-items: center;
				background-color: var(--color-yellow);
				block-size: var(--size-7);
				border-radius: var(--radius-4);
				color: var(--color-white);
				display: flex;
				justify-content: center;
				inline-size: var(--size-7);
				transition: all 200ms ease;

				&:hover {
					background-color: var(--color-text);
					@media (prefers-color-scheme: dark) {
						color: var(--color-surface-1);
					}
				}
			}

			.textarea-container {
				align-items: end;
				display: flex;
				gap: var(--size-1);
			}

			.actions {
				display: flex;
				margin-block-end: var(--size-1-5);
			}

			.action-trigger {
				align-items: center;
				block-size: var(--size-7);
				border-radius: var(--radius-4);
				color: color-mix(in srgb, var(--color-text), transparent 30%);
				display: flex;
				justify-content: center;
				inline-size: var(--size-7);
				transition: all 200ms ease;

				&:hover,
				:global(:focus-visible) & {
					background-color: var(--color-surface-2);
				}
			}
		}
	}

	.staged-files {
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-1);
		inline-size: 100%;
		padding-block-start: var(--size-2);
		margin-inline-start: calc(-1 * var(--size-0-5));

		button {
			align-items: center;
			block-size: var(--size-5-5);
			border-radius: var(--radius-2-5);
			border: var(--size-px) solid var(--color-border-1);
			cursor: pointer;
			display: flex;
			font-size: var(--font-size-1);
			font-weight: var(--font-weight-5);
			gap: var(--size-0-5);
			justify-content: center;
			max-inline-size: var(--size-56);
			padding-inline: var(--size-1);
			overflow: hidden;
			text-align: left;

			& :global(svg) {
				opacity: 0.5;
				flex: none;
			}

			.file-path {
				text-overflow: ellipsis;
				overflow: hidden;
				white-space: nowrap;
				flex: 1;
				opacity: 0.7;
			}

			.close-button {
				border-radius: var(--radius-2);
				block-size: var(--size-4);
				flex: none;
				inline-size: var(--size-4);
				transition: all 150ms ease;
			}

			&:hover .close-button {
				background-color: var(--color-surface-2);
			}
		}
	}
</style>
