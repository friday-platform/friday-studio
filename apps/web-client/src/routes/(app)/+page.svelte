<script lang="ts">
import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
import { circOut } from "svelte/easing";
import { SvelteMap } from "svelte/reactivity";
import { slide } from "svelte/transition";
import { z } from "zod";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { getChatContext } from "$lib/chat-context.svelte";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
import Outline from "$lib/modules/conversation/outline.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import FlexibleContainer from "$lib/modules/messages/flexible-container.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Progress from "$lib/modules/messages/progress.svelte";
import Reasoning from "$lib/modules/messages/reasoning.svelte";
import Request from "$lib/modules/messages/request.svelte";
import Response from "$lib/modules/messages/response.svelte";
import ShowDetails from "$lib/modules/messages/show-details.svelte";
import { formatChatDate } from "$lib/utils/date";
import { shareChat } from "$lib/utils/share-chat";
import { invoke } from "$lib/utils/tauri-loader";

const appCtx = getAppContext();
const chatContext = getChatContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let showChats = $state(false);

// Fetch recent chats on mount
$effect(() => {
  if (chatContext.chat?.messages.length === 0) {
    chatContext.loadRecentChats().catch((err) => {
      console.error("Failed to load recent chats:", err);
    });
  }
});

// Follow scroll handling
let scrollContainer = $state<HTMLDivElement | null>(null);
let animationFrameId = $state<number | null>(null);

// Handle Scrolling
function handleScroll() {
  chatContext.userHasScrolled = true;

  if (!scrollContainer) return;

  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 5;

  // If user scrolls away from bottom, mark as manually scrolled
  if (!isAtBottom) {
    chatContext.userHasScrolled = true;
  }
  // If user scrolls back to bottom, reset the flag
  if (isAtBottom) {
    chatContext.userHasScrolled = false;
  }
}

// Scroll to the bottom of the container
function scrollToBottom() {
  if (!scrollContainer) return;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
  animationFrameId = requestAnimationFrame(scrollToBottom);
}

// Auto-scroll when new logs are added, unless user has manually scrolled
$effect(() => {
  if (chatContext.userHasScrolled && animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (!chatContext.userHasScrolled && !animationFrameId) {
    animationFrameId = requestAnimationFrame(scrollToBottom);
  }
});

const hasMessages = $derived(chatContext.chat?.messages.length > 0);
let actionsAfterLastUser = $state<{ parts: AtlasUIMessagePart[]; timestamp?: string }>({
  parts: [],
});

$effect(() => {
  const lastAssistantMessage = (chatContext.chat?.messages ?? []).findLast(
    (msg) => msg.role === "assistant",
  );

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

<div class="chat">
	<div class="main">
		<div
			class="messages"
			class:has-messages={hasMessages}
			bind:this={scrollContainer}
			onscroll={handleScroll}
		>
			<div
				class="messages-container"
				class:has-outline={chatContext.chat?.messages.some((msg) =>
					msg.parts.some((part) => part.type === 'data-outline-update')
				)}
			>
				<div class="messages-inner">
					<FlexibleContainer>
						<div class="first-message">
							<h2>Welcome</h2>
							<p>
								Welcome to Atlas. I can help turn your ideas into action. <br />What would you like
								to work on today?
							</p>
						</div>
					</FlexibleContainer>

					{#each chatContext.chat?.messages as messageContainer (messageContainer.id)}
						<div class="message-parts">
							{#each messageContainer.parts as message, index (index)}
								{@const formattedMessage = formatMessage(messageContainer, message)}

								{#if formattedMessage}
									{#if formattedMessage.type === 'request'}
										<Request message={formattedMessage} />
									{:else if formattedMessage.type === 'text'}
										<Response message={formattedMessage} parts={messageContainer.parts} />
									{:else if formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'display_artifact' && formattedMessage.metadata?.artifactId}
										<DisplayArtifact artifactId={formattedMessage.metadata.artifactId as string} />
									{:else if formattedMessage.type === 'error'}
										<ErrorMessage message={formattedMessage} />
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
					{/each}

					{#if chatContext.chat?.status === 'streaming' || chatContext.chat?.status === 'submitted'}
						<Progress
							actions={actionsAfterLastUser.parts}
							timestamp={actionsAfterLastUser.timestamp}
						/>
					{/if}
				</div>

				<Outline
					messages={(chatContext.chat?.messages ?? [])
						.filter((msg) => msg.role === 'assistant')
						.filter((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
				/>
			</div>

			<div class="spacer"></div>

			<div
				class="interactive-container"
				class:has-outline={chatContext.chat?.messages.some((msg) =>
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

							if (message.trim() && chatContext.chat) {
								let combinedMessage = message;
								if (appCtx.stagedFiles.state.size > 0) {
									combinedMessage = combinedMessage + `\n\nAttachments:`;

									for (const id of appCtx.stagedFiles.state.keys()) {
										combinedMessage = combinedMessage + `\n- ${id}`;
									}
								}

								chatContext.chat.sendMessage({ text: combinedMessage });
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

								chatContext.userHasScrolled = false;
								scrollToBottom();
							} catch (e) {
								console.error(e);
							}
						}}
					>
						{#if appCtx.stagedFiles.state.size > 0}
							<div class="staged-files">
								{#each appCtx.stagedFiles.state.entries() as [itemId, file]}
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

											{#if hasMessages}
												<DropdownMenu.Item
													onclick={async () => {
														if (chatContext.chat?.messages) {
															const chatTitle = chatContext.recentChats.find(
																(c) => c.id === chatContext.id
															)?.title;
															await shareChat(chatContext.chat.messages, chatTitle);
														}
													}}
												>
													<Icons.Share />

													Share
												</DropdownMenu.Item>
											{/if}

											<DropdownMenu.Item
												onclick={() => {
													chatContext.newChat();
												}}
											>
												<Icons.Chat />
												New Chat</DropdownMenu.Item
											>
											{#if chatContext.recentChats.length > 0}
												<DropdownMenu.Separator />

												<DropdownMenu.Label>Past Conversations</DropdownMenu.Label>

												<DropdownMenu.List>
													{#each chatContext.recentChats as chat (chat.id)}
														<DropdownMenu.Item
															onclick={() => {
																chatContext.loadChat(chat.id);
															}}
														>
															<span class="action-recent-chat-label">
																{chat.title || '(Untitled)'}
															</span>

															{#snippet description()}
																{formatChatDate(chat.updatedAt)}
															{/snippet}
														</DropdownMenu.Item>
													{/each}
												</DropdownMenu.List>
											{/if}
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
								{#if chatContext.chat?.status === 'streaming' || chatContext.chat?.status === 'submitted'}
									<button
										class="stop-process"
										type="button"
										onclick={async (e) => {
											e.preventDefault();

											chatContext.chat.stop();
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

				{#if !hasMessages && chatContext.recentChats.length > 0}
					<div class="recent-conversations" class:open={showChats}>
						<button
							class="toggle-chats"
							onclick={() => {
								showChats = !showChats;
							}}>Recent Conversations <IconSmall.CaretRight /></button
						>
						{#if showChats}
							<div class="chat-list" transition:slide={{ duration: 200, easing: circOut }}>
								{#each chatContext.recentChats.slice(0, 5) as chat (chat.id)}
									<button
										class="chat-item"
										onclick={() => {
											chatContext.loadChat(chat.id);
										}}
									>
										<span class="chat--title">{chat.title || '(Untitled)'}</span>
										<span class="chat--date" title={new Date(chat.updatedAt).toLocaleString()}
											>{formatChatDate(chat.updatedAt)}</span
										>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>

			{#if hasMessages}
				<div class="background-blur"></div>
			{/if}
		</div>

		{#if !hasMessages}
			<footer>
				<span>Made By Tempest</span>
			</footer>
		{/if}
	</div>
</div>

<style>
	.chat {
		block-size: 100%;
		display: grid;
		grid-template-columns: 1fr;
		inline-size: 100%;
		overflow: hidden;
		position: relative;
		transition: all 150ms ease;
		z-index: var(--layer-0);
	}

	.main {
		justify-content: center;
		display: flex;
		block-size: 100%;
		overflow: hidden;
		flex-direction: column;
		position: relative;
	}

	.first-message {
		h2 {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
			margin-block-end: var(--size-2);
		}

		p {
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-4);
			opacity: 0.8;
		}
	}

	.messages {
		block-size: 100%;
		display: flex;
		flex-direction: column;
		overflow-y: scroll;
		padding-block: var(--size-10) var(--size-16);
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
		flex: 0 1;
		transition: flex 450ms ease-in-out;

		.has-messages & {
			flex: 1;
		}
	}

	.messages-container {
		display: grid;
		grid-template-columns: 1fr 0;
		gap: 0;
		margin-block-start: auto;
		padding-block-end: var(--size-6);
		transition:
			grid-template-columns 450ms ease-in-out,
			gap 450ms ease-in-out;

		&.has-outline {
			grid-template-columns: 1fr var(--size-56);
			gap: var(--size-12);
		}
	}

	.message-parts {
		margin-inline: auto;
		inline-size: max-content;
		min-inline-size: var(--size-160);
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
		gap: var(--size-4);
		overflow: hidden;
	}

	footer {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		opacity: 0.5;
		margin-block-start: auto;
		text-align: center;
		padding-block-end: var(--size-7);
		position: absolute;
		inset-block-end: 0;
		inset-inline: 0;
		z-index: var(--layer-1);
	}

	.interactive-container {
		--local__translate-y: 0;
		--local__translate-x: 0;
		inline-size: 100%;
		margin-inline: auto;
		margin-block-end: auto;
		max-inline-size: var(--size-160);
		overflow: visible;
		padding-inline: var(--size-8);
		position: sticky;
		inset-block-end: 0;
		z-index: var(--layer-2);
		transform: translateY(var(--local__translate-y)) translateX(var(--local__translate-x));

		.has-messages & {
			--local__translate-y: var(--size-4);
			transition: transform 450ms ease-in-out;
		}

		&.has-outline {
			--local__translate-x: calc(-1 * calc(var(--size-28) + var(--size-6)));
			transition: transform 450ms ease-in-out;
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

	.action-recent-chat-label {
		overflow: hidden;
		text-overflow: ellipsis;
		max-inline-size: 100%;
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

	.recent-conversations {
		padding-inline: var(--size-4);
		padding-block-start: var(--size-3-5);

		.toggle-chats {
			align-items: center;
			display: flex;
			gap: var(--size-1);
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			opacity: 0.5;
			padding-block-end: var(--size-3);

			.open & :global(svg) {
				transform: rotate(90deg);
			}
		}

		.chat-list {
			button {
				border-block-start: 1px solid color-mix(in srgb, var(--color-border-1) 50%, transparent);
				display: flex;
				justify-content: space-between;
				inline-size: 100%;
				padding-block: var(--size-3);
			}
		}

		.chat--title {
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			opacity: 0.7;
		}

		.chat--date {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			opacity: 0.5;
		}
	}
</style>
