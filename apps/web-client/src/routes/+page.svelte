<script lang="ts">
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import Button from "$lib/components/button.svelte";
import Dropzone from "$lib/components/dropzone/dropzone.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import { getClientContext } from "$lib/modules/client/context.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";

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
function handleScroll() {
  if (!scrollContainer) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 50;

  // If user scrolls away from bottom, mark as manually scrolled
  if (!isAtBottom) {
    userHasScrolled = true;
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
		<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
			<div class="messages-inner">
				{#each ctx.messages as message, index (index)}
					{@const formattedMessage = formatMessage(message, ctx.user)}

					{#if formattedMessage && (formattedMessage.type === 'request' || formattedMessage.type === 'text')}
						<Message message={formattedMessage} />
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

		{#if ctx.messages.filter((m) => m.type !== 'data-connection' && m.type !== 'data-heartbeat').length === 0}
			<h2>Welcome to Atlas</h2>
		{/if}

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
				placeholder="What can I help you with?"
				bind:value={message}
			></textarea>

			<div class="actions">
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

				<Button type="submit">Send</Button>
			</div>
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
{/if}

<style>
	.chat {
		block-size: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		inline-size: 100%;
		overflow: hidden;
		padding-block-end: var(--size-16);
		position: relative;
		transition: all 150ms ease;
		z-index: var(--layer-1);
	}

	.messages {
		padding-block: var(--size-8);
		overflow-y: scroll;
		scrollbar-width: thin;
		padding-inline: var(--size-8);

		.messages-inner {
			display: flex;
			gap: var(--size-12);
			flex-direction: column;
			max-inline-size: 75ch;
			margin-inline: auto;
		}
	}

	h2 {
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-7);
		line-height: var(--font-lineheight-1);
		text-align: center;
		margin-block-end: var(--size-6);
	}

	form {
		background-color: var(--background-1);
		border-radius: var(--radius-4);
		bottom: 0;
		box-shadow: var(--shadow-1);
		display: block;
		margin-inline: auto;
		max-inline-size: 75ch;
		inline-size: 100%;
		padding-block-end: var(--size-10-5);
		position: sticky;
		z-index: var(--layer-2);

		&:has(textarea:disabled) {
			opacity: 0.5;
		}

		textarea {
			background-color: transparent;
			block-size: var(--size-20);
			display: block;
			font-size: var(--font-size-5);
			padding: var(--size-3);
			padding-block-end: 0;
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
			position: absolute;
			inset-inline-start: var(--size-2);
			inset-inline-end: var(--size-2);
			inset-block-end: var(--size-2);

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
