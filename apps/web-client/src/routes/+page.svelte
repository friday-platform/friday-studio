<script lang="ts">
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";

import Dropzone from "$lib/components/dropzone/dropzone.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import { getClientContext } from "$lib/modules/client/context.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import Table from "$lib/modules/messages/table.svelte";

const { stagedFiles, daemonClient, uploadFile } = getAppContext();

const ctx = getClientContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let scrollContainer = $state<HTMLDivElement | null>(null);
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);

onMount(async () => {
  ctx.setup();
});

// Handle Scrolling
// function handleScroll() {
// 	if (!scrollContainer) return;
// 	const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
// 	const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 50;

// 	// If user scrolls away from bottom, mark as manually scrolled
// 	if (!isAtBottom) {
// 		userHasScrolled = true;
// 	}
// 	// If user scrolls back to bottom, reset the flag
// 	if (isAtBottom) {
// 		userHasScrolled = false;
// 	}
// }

// // Scroll to the bottom of the container
// function scrollToBottom() {
// 	if (!scrollContainer) return;
// 	scrollContainer.scrollTop = scrollContainer.scrollHeight;

// 	animationFrameId = requestAnimationFrame(scrollToBottom);
// }

// // Auto-scroll when new logs are added, unless user has manually scrolled
// $effect(() => {
// 	if (userHasScrolled && animationFrameId) {
// 		cancelAnimationFrame(animationFrameId);
// 		animationFrameId = null;
// 	}

// 	if (!userHasScrolled && !animationFrameId) {
// 		animationFrameId = requestAnimationFrame(scrollToBottom);
// 	}
// });
</script>

{#if ctx.daemonStatus === 'error'}
	<p class="daemon-error">
		Error: The atlas daemon is not running <button type="button" onclick={() => ctx.checkHealth()}
			>Try again</button
		>
	</p>
{:else}
	<div
		class="chat"
		class:has-messages={ctx.messages.filter(
			(m) => m.type !== 'data-connection' && m.type !== 'data-heartbeat'
		).length > 0}
	>
		<div class="main">
			<h2>Chat</h2>

			{#if ctx.messages.filter((m) => m.type !== 'data-connection' && m.type !== 'data-heartbeat').length === 0}
				<p class="empty-message">What do you want to accomplish today?</p>
			{/if}

			<div class="messages" bind:this={scrollContainer}>
				<div class="messages-inner">
					{#each ctx.messages as message, index (message.id || index)}
						{@const formattedMessage = formatMessage(message, ctx.user)}

						{#if formattedMessage && (formattedMessage.type === 'request' || formattedMessage.type === 'text')}
							<Message message={formattedMessage} />
						{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'table_output'}
							<Table data={formattedMessage.metadata?.result} />
						{:else if formattedMessage && formattedMessage.type === 'error'}
							<ErrorMessage message={formattedMessage} />
						{/if}
					{/each}

					{#if ctx.typingState.isTyping}
						{@const actionsAfterLastUser = (() => {
							// Find the last data-user-message
							const lastUserIndex = ctx.messages.findLastIndex(
								(msg) => msg.type === 'data-user-message'
							);

							// If no user message found, return empty
							if (lastUserIndex === -1) return [];

							// Return everything after the last user message
							return ctx.messages.slice(lastUserIndex + 1);
						})()}

						<Progress actions={actionsAfterLastUser} />
					{/if}
				</div>
			</div>

			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<form
				bind:this={form}
				title={ctx.typingState.isTyping
					? 'Processing... (press escape to cancel the current request)'
					: undefined}
				method="POST"
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
						e.preventDefault();
						e.currentTarget?.requestSubmit();
					}
				}}
				onsubmit={async (e) => {
					e.preventDefault();

					if (!ctx.conversationClient || !ctx.conversationSessionId || ctx.typingState.isTyping) {
						return;
					}

					try {
						const formData = new FormData(e.target as HTMLFormElement);
						let formMessage = formData.get('message') as string;

						if (stagedFiles.state.size > 0) {
							formMessage = formMessage + `\n\nLibrary attachments:`;

							for (const id of stagedFiles.state.keys()) {
								formMessage = formMessage + `\n- ${id}`;
							}
						}

						if (formMessage.trim().length === 0) {
							return;
						}

						// Just send the message - the persistent SSE listener will handle the response
						await ctx.conversationClient.sendMessage(ctx.conversationSessionId, formMessage);

						message = '';

						// The persistent SSE listener will handle the response
					} catch (e) {
						console.error(e);
					}
				}}
			>
				<textarea
					disabled={ctx.typingState.isTyping}
					name="message"
					placeholder="Type here..."
					bind:value={message}
				></textarea>

				<!-- <div class="actions">
					<div class="file-drop">
						<Dropzone
							maxSize={Infinity}
							accept={['*']}
							onDrop={(files) => {
								for (const file of files) {
									uploadFile(file);
								}
							}}
						>
							<span class="file-drop-children">
								<CustomIcons.Paperclip />
								<span>Add Files</span>
							</span>
						</Dropzone>
					</div>
				</div> -->
			</form>

			{#if stagedFiles.state.size > 0}
				<div class="staged-files">
					{#each stagedFiles.state.entries() as [itemId, file]}
						<button
							onclick={async () => {
								await daemonClient.deleteLibraryItem(itemId);

								stagedFiles.remove(itemId);
							}}>{file.name} <IconSmall.Close /></button
						>
					{/each}
				</div>
			{/if}
		</div>

		<aside>
			<h2>Artifacts</h2>

			<span>Start a chat to see artifacts</span>
		</aside>
	</div>
{/if}

<style>
	.chat {
		block-size: 100%;
		display: grid;
		grid-template-columns: 1fr var(--size-64);
		inline-size: 100%;
		overflow: hidden;
		position: relative;
		transition: all 150ms ease;
		z-index: var(--layer-1);

		.main {
			display: flex;
			block-size: 100%;
			overflow: hidden;
			flex-direction: column;
			padding: var(--size-10);
			padding-inline-end: var(--size-10);

			h2 {
				font-size: var(--font-size-7);
				font-weight: var(--font-weight-7);
				line-height: var(--font-lineheight-1);
			}

			.empty-message {
				font-size: var(--font-size-4);
				opacity: 0.7;
				font-weight: var(--font-weight-4);
			}
		}

		aside {
			padding-block: var(--size-10);

			h2 {
				color: var(--text-3);
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-1);
			}

			span {
				color: var(--text-3);
				font-size: var(--font-size-2);
				opacity: 0.8;
				font-weight: var(--font-weight-4);
			}
		}
	}

	.messages {
		flex: 1;
		overflow-y: scroll;
		scrollbar-width: thin;
		padding-block: var(--size-6);

		.messages-inner {
			display: flex;
			flex-direction: column;
			max-inline-size: 75ch;
			inline-size: 100%;
		}
	}

	form {
		background-color: var(--background-1);
		display: flex;
		bottom: 0;

		position: sticky;
		z-index: var(--layer-2);

		&:has(textarea:disabled) {
			opacity: 0.5;
		}

		textarea {
			background-color: transparent;
			border-radius: var(--radius-4);
			block-size: var(--size-9);
			box-shadow: var(--shadow-1);
			display: block;
			font-size: var(--font-size-3);
			padding-inline: var(--size-3);
			padding-block-start: var(--size-2);
			scrollbar-width: thin;
			inline-size: 100%;
			resize: none;

			&:focus {
				outline: none;
			}

			&::placeholder {
				color: color-mix(in oklch, var(--text-3) 70%, transparent);
			}
		}

		.actions {
			align-items: center;
			display: flex;
			justify-content: space-between;

			.file-drop {
				block-size: var(--size-6);
				margin-inline-start: var(--size-1);
				position: relative;
				inline-size: 4.6875rem;
			}

			.file-drop-children {
				color: var(--text-3);
				display: flex;
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
				gap: var(--size-1-5);
				inline-size: max-content;
			}
		}
	}

	.chat.has-messages form {
		margin-block-start: auto;
	}

	.staged-files {
		display: flex;
		gap: var(--size-2);
		margin-inline: auto;
		max-inline-size: 75ch;
		inline-size: 100%;
		margin-block-start: var(--size-2);
		padding-inline: var(--size-2);

		button {
			background-color: var(--highlight-1);
			border-radius: var(--radius-2);
			border: none;
			block-size: var(--size-5-5);
			cursor: pointer;
			font-size: var(--font-size-2);
			padding-inline: var(--size-2) var(--size-1);
			align-items: center;
			display: flex;
			justify-content: center;
			font-weight: var(--font-weight-5);
			color: var(--text-3);
			gap: var(--size-1);
			transition: all 150ms ease;

			&:hover {
				background-color: var(--highlight-3);
			}
		}
	}

	.daemon-error {
		color: var(--text-3);
		font-size: var(--font-size-5);
		text-align: center;
		margin-block-end: var(--size-6);

		button {
			color: var(--accent-1);
			cursor: pointer;
			text-decoration: underline;
		}
	}
</style>
