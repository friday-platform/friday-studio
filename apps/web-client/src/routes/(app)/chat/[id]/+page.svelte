<script lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { onMount } from "svelte";
import { page } from "$app/state";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import Artifacts from "$lib/modules/artifacts/artifacts.svelte";
import { getClientContext } from "$lib/modules/client/context.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import Table from "$lib/modules/messages/table.svelte";

const appCtx = getAppContext();

const ctx = getClientContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let scrollContainer = $state<HTMLDivElement | null>(null);
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);

onMount(() => {
  ctx.conversationSessionId = page.params.id;
  ctx.getConversation(page.params.id);
  ctx.createSession();
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

const formattedMessages = $derived(ctx.formattedMessages);
const rawMessages = $derived([...ctx.messageHistory, ...ctx.messages]);
</script>

<div
	class="chat"
	class:has-messages={formattedMessages.length > 0}
>
	<div class="main">
		<h2>{page.params.id}</h2>

		{#if formattedMessages.length === 0}
			<div class="empty-message">
				<p>Welcome to Atlas! What can I help you build?</p>
				<p>Tip: You can drag and drop files to attach them to your message.</p>
			</div>
		{/if}

		<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
			<div class="messages-inner">
				{#each formattedMessages as formattedMessage, index (formattedMessage.id || index)}

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
						const lastUserIndex = rawMessages.findLastIndex((msg) => msg.type === 'data-user-message');

						// If no user message found, return empty
						if (lastUserIndex === -1) return [];

						// Return everything after the last user message
						return rawMessages.slice(lastUserIndex + 1);
					})()}

					<Progress actions={actionsAfterLastUser} />
				{/if}
			</div>
		</div>

		<div class="interactive-container">
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
						let formMessage = formData.get('message');

						if (appCtx.stagedFiles.state.size > 0) {
							formMessage = formMessage + `\n\nLibrary attachments:`;

							for (const id of appCtx.stagedFiles.state.keys()) {
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
				<Textarea
					disabled={ctx.typingState.isTyping}
					name="message"
					placeholder="Type here..."
					value={message}
					onTextChange={(value) => {
						message = value;
					}}
				/>

				<div class="actions">
					<button
						class="file-drop"
						onclick={async () => {
							const file = await open({
								multiple: true,
								directory: true
							});

							if (file) {
								appCtx.stagedFiles.add(file[0], {
									path: file[0],
									type: getFileType(file[0])
								});
							}
						}}
					>
						<CustomIcons.Paperclip />
					</button>
				</div>
			</form>

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
	</div>

	<aside>
		<h2>Artifacts and history</h2>

		<Artifacts />
	</aside>
</div>

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
			padding-inline-end: var(--size-10);

			h2 {
				font-size: var(--font-size-4);
				font-weight: var(--font-weight-7);
				line-height: var(--font-lineheight-1);
				padding-inline: var(--size-10);
				padding-block-start: var(--size-10);
			}

			.empty-message {
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-4);
				margin-block-start: var(--size-6);
				margin-inline: var(--size-10);

				p:last-child {
					opacity: 0.6;
				}
			}
		}

		aside {
			padding-block: var(--size-10);

			h2 {
				color: var(--text-3);
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-1);
			}
		}
	}

	.messages {
		flex: 1;
		overflow-y: scroll;
		scrollbar-width: thin;
		padding-block: var(--size-6);
		padding-inline: var(--size-10);

		.messages-inner {
			display: flex;
			flex-direction: column;
			max-inline-size: 75ch;
			inline-size: 100%;
		}
	}

	.interactive-container {
		position: sticky;
		inset-block-end: var(--size-10);
		padding-inline: var(--size-10);
		z-index: var(--layer-2);
	}

	form {
		background-color: var(--color-surface-1);
		display: flex;
		max-inline-size: 75ch;
		position: relative;

		& :global(textarea:disabled) {
			opacity: 0.5;
		}

		.actions {
			position: absolute;
			inset-inline-end: var(--size-1);
			inset-block-start: var(--size-1);

			.file-drop {
				align-items: center;
				block-size: var(--size-7);
				border-radius: var(--radius-3);
				color: var(--accent-1);
				display: flex;
				display: flex;
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-5);
				gap: var(--size-1-5);
				inline-size: var(--size-7);
				justify-content: center;
				transition: all 150ms ease;

				&:hover {
					background-color: var(--highlight-1);
				}
			}
		}
	}

	.chat.has-messages form {
		margin-block-start: auto;
	}

	.staged-files {
		display: flex;
		gap: var(--size-4);
		max-inline-size: 75ch;
		inline-size: 100%;
		margin-block-start: var(--size-2);
		padding-inline: var(--size-2);

		button {
			align-items: start;
			border: none;
			color: var(--text-1);
			cursor: pointer;
			display: flex;
			font-size: var(--font-size-1);
			gap: var(--size-1-5);
			max-inline-size: var(--size-56);
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
					font-size: var(--font-size-1);
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

	.daemon-error {
		color: var(--text-3);
		font-size: var(--font-size-1);
		font-weight: var(--font-weight-4-5);
		text-align: center;
		margin-block-end: var(--size-6);

		button {
			color: var(--accent-1);
			cursor: pointer;
			text-decoration: underline;
		}
	}
</style>
