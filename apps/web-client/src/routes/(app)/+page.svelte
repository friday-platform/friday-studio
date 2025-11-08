<script lang="ts">
import { circOut } from "svelte/easing";
import { slide } from "svelte/transition";
import { z } from "zod";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { getChatContext } from "$lib/chat-context.svelte";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import Table from "$lib/modules/messages/table.svelte";
import { formatChatDate } from "$lib/utils/date";
import { invoke } from "$lib/utils/tauri-loader";

const appCtx = getAppContext();
const chatContext = getChatContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let showChats = $state(false);

const messages = $derived(chatContext.chat?.messages ?? []);
const status = $derived(chatContext.chat?.status ?? "idle");

// Fetch recent chats on mount
$effect(() => {
  if (messages.length === 0) {
    chatContext.loadRecentChats().catch((err) => {
      console.error("Failed to load recent chats:", err);
    });
  }
});

// Follow scroll handling
let scrollContainer = $state<HTMLDivElement | null>(null);
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);

// Handle Scrolling
function handleScroll() {
  userHasScrolled = true;

  if (!scrollContainer) return;

  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 5;

  // If user scrolls away from bottom, mark as manually scrolled
  if (!isAtBottom) {
    userHasScrolled = true;
  }
  // If user scrolls back to bottom, reset the flag
  if (isAtBottom) {
    userHasScrolled = false;
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
  if (userHasScrolled && animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (!userHasScrolled && !animationFrameId) {
    animationFrameId = requestAnimationFrame(scrollToBottom);
  }
});

const hasMessages = $derived(messages.length > 0);
</script>

<div class="chat">
	<div class="main">
		<div
			class="messages"
			class:has-messages={hasMessages}
			bind:this={scrollContainer}
			onscroll={handleScroll}
		>
			<div class="messages-inner">
				<div class="first-message">
					<h2>Welcome</h2>
					<p>
						Welcome to Atlas. I can help turn your ideas into action. <br />What would you like to
						work on today?
					</p>
				</div>

				{#each messages as messageContainer (messageContainer.id)}
					{#each messageContainer.parts as message, index (index)}
						{@const formattedMessage = formatMessage(messageContainer, message)}

						{#if formattedMessage && (formattedMessage.type === 'request' || formattedMessage.type === 'text')}
							<Message message={formattedMessage} />
						{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'table_output' && formattedMessage.metadata?.result}
							<Table
								data={formattedMessage.metadata.result as {
									data: { headers: string[]; rows: Record<string, string | number>[] };
								}}
							/>
						{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'display_artifact' && formattedMessage.metadata?.artifactId}
							<DisplayArtifact artifactId={formattedMessage.metadata.artifactId as string} />
						{:else if formattedMessage && formattedMessage.type === 'error'}
							<ErrorMessage message={formattedMessage} />
						{/if}
					{/each}
				{/each}

				{#if status === 'streaming' || status === 'submitted'}
					{@const actionsAfterLastUser = (() => {
						// Find the last data-user-message
						const lastAssistantMessage = messages.findLast((msg) => msg.role === 'assistant');

						// If no user message found, return empty
						if (!lastAssistantMessage) return [];

						// Return everything after the last user message
						return lastAssistantMessage.parts;
					})()}

					<Progress actions={actionsAfterLastUser} />
				{/if}
			</div>

			<div class="spacer"></div>

			<div class="interactive-container">
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

								userHasScrolled = false;
								scrollToBottom();
							} catch (e) {
								console.error(e);
							}
						}}
					>
						<Textarea
							name="message"
							placeholder="Type here..."
							value={message}
							onTextChange={(value) => {
								message = value;
							}}
						/>

						<div class="form-action">
							{#if status === 'streaming' || status === 'submitted'}
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
					</form>

					<div class="actions">
						{#if __TAURI_BUILD__}
							<button
								class="file-drop"
								type="button"
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
							</button>
						{/if}

						<!-- <button
						class="file-drop"
						type="button"
						onclick={async (e) => {
							e.preventDefault();

							// @TODO implement some search examples
						}}
					>
						<Icons.Globe />

						Search Sites
					</button>

					<button
						class="file-drop"
						type="button"
						onclick={async (e) => {
							e.preventDefault();

							// @TODO implement some event examples
						}}
					>
						<div class="date">
							{new Date().getDate()}
						</div>

						Manage Events
					</button> -->
					</div>
					{#if appCtx.stagedFiles.state.size > 0}
						<div class="staged-files">
							{#each appCtx.stagedFiles.state.entries() as [itemId, file]}
								<button
									onclick={async () => {
										appCtx.stagedFiles.remove(itemId);
									}}
								>
									{#if file.type === 'file'}
										<IconSmall.File />
									{:else}
										<IconSmall.Folder />
									{/if}

									<div class="file-details">
										<span>{file.path}</span>
										<span>{file.type === 'file' ? 'File' : 'Folder'}</span>
									</div>

									<span class="close-button">
										<IconSmall.Close />
									</span>
								</button>
							{/each}
						</div>
					{/if}
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
								{#each chatContext.recentChats as chat (chat.id)}
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
		inline-size: 100%;
		margin-inline: auto;
		max-inline-size: var(--size-150);
		padding-inline: var(--size-2);

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
	}

	.background-blur {
		background: var(--color-surface-1);
		block-size: var(--size-28);
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

	.messages-inner {
		display: flex;
		flex-direction: column;
		gap: var(--size-4);
		margin-block-start: auto;
		padding-block-end: var(--size-6);
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
		inline-size: 100%;
		margin-inline: auto;
		margin-block-end: auto;
		max-inline-size: var(--size-150);
		overflow: visible;
		position: sticky;
		inset-block-end: 0;
		z-index: var(--layer-2);

		.has-messages & {
			transform: translateY(var(--size-4));
			transition: transform 450ms ease-in-out;
		}

		form {
			display: flex;
			position: relative;

			.form-action {
				display: flex;
				inset-inline-end: var(--size-1-5);
				inset-block-end: var(--size-1-5);
				position: absolute;
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
		}

		.actions {
			align-items: center;
			display: flex;
			gap: var(--size-2);
			padding-block-start: var(--size-3);
			padding-inline: var(--size-3);

			button {
				align-items: center;
				border-radius: var(--radius-3);
				color: var(--accent-1);
				display: flex;
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
				gap: var(--size-1);
				justify-content: center;
				padding: var(--size-1);
				opacity: 0.7;
				transition: all 150ms ease;

				&:hover {
					background-color: var(--color-surface-2);
					opacity: 1;
				}

				& :global(svg) {
					flex: none;
					opacity: 0.7;
				}
			}
		}
	}

	.staged-files {
		display: flex;
		gap: var(--size-4);
		inline-size: 100%;
		margin-block-start: var(--size-2);
		padding-inline: var(--size-4);

		button {
			align-items: start;
			border: none;
			color: var(--color-text);
			cursor: pointer;
			display: flex;
			font-size: var(--font-size-2);
			gap: var(--size-1-5);
			max-inline-size: var(--size-56);
			opacity: 0.7;
			justify-content: center;
			overflow: hidden;
			text-align: left;

			& :global(svg) {
				color: var(--text-3);
				flex: none;
			}

			.file-details {
				align-items: start;
				display: flex;
				flex-direction: column;
				font-weight: var(--font-weight-4-5);
				gap: var(--size-0-5);
				line-height: var(--font-lineheight-1);
				overflow: hidden;
				inline-size: 100%;

				span:first-child {
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					max-inline-size: 100%;
				}

				span:last-child {
					color: var(--text-3);
					font-size: var(--font-size-2);
					font-weight: var(--font-weight-4);
					opacity: 0.8;
				}
			}

			.close-button {
				background-color: var(--highlight-1);
				border-radius: var(--radius-2);
				block-size: var(--size-4);
				flex: none;
				inline-size: var(--size-4);
				transition: all 150ms ease;

				& :global(svg) {
					color: var(--accent-1);
				}
			}
			&:hover .close-button {
				background-color: var(--highlight-3);
			}
		}
	}

	.recent-conversations {
		padding-inline: var(--size-4);
		padding-block-start: var(--size-6);

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
