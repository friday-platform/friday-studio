<script lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { onMount } from "svelte";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
import { getClientContext } from "$lib/modules/client/context.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import Table from "$lib/modules/messages/table.svelte";

const appCtx = getAppContext();

const clientCtx = getClientContext();

let form = $state<HTMLFormElement | null>(null);
let scrollContainer = $state<HTMLDivElement | null>(null);

let message = $state<string>("");
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);

onMount(() => {
  if (!clientCtx.conversationSessionId) {
    clientCtx.createSession();
  }
});

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

const hasMessages = $derived(
  clientCtx.messages.filter((m) => m.type !== "data-connection" && m.type !== "data-heartbeat")
    .length > 0,
);
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

				{#each clientCtx.messages as message, index (message.id || index)}
					{@const formattedMessage = formatMessage(message, clientCtx.user)}

					{#if formattedMessage && (formattedMessage.type === 'request' || formattedMessage.type === 'text')}
						<Message message={formattedMessage} />
					{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'table_output'}
						<Table data={formattedMessage.metadata?.result} />
					{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'display_artifact'}
						<!-- @ts-expect-error: this is accurate but poorly typed right now -->
						<DisplayArtifact artifactId={formattedMessage.metadata?.artifactId} />
					{:else if formattedMessage && formattedMessage.type === 'error'}
						<ErrorMessage message={formattedMessage} />
					{/if}
				{/each}

				{#if clientCtx.typingState.isTyping}
					{@const actionsAfterLastUser = (() => {
						// Find the last data-user-message
						const lastUserIndex = clientCtx.messages.findLastIndex(
							(msg) => msg.type === 'data-user-message'
						);

						// If no user message found, return empty
						if (lastUserIndex === -1) return [];

						// Return everything after the last user message
						return clientCtx.messages.slice(lastUserIndex + 1);
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
						title={clientCtx.typingState.isTyping
							? 'Processing... (press escape to cancel the current request)'
							: undefined}
						onkeydown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
								e.preventDefault();
								e.currentTarget?.requestSubmit();
							}
						}}
						onsubmit={async (e) => {
							e.preventDefault();

							if (
								!clientCtx.conversationClient ||
								!clientCtx.conversationSessionId ||
								clientCtx.typingState.isTyping
							) {
								return;
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

								if (
									!formMessage ||
									typeof formMessage !== 'string' ||
									formMessage.trim().length === 0
								) {
									return;
								}

								userHasScrolled = false;
								scrollToBottom();

								// Just send the message - the persistent SSE listener will handle the response
								await clientCtx.conversationClient.sendMessage(
									clientCtx.conversationSessionId,
									formMessage
								);

								message = '';
								appCtx.stagedFiles.clear();

								// The persistent SSE listener will handle the response
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
							{#if clientCtx.typingState.isTyping}
								<button
									class="stop-process"
									type="button"
									onclick={async (e) => {
										e.preventDefault();

										if (!clientCtx.atlasSessionId) return;

										clientCtx.conversationClient?.cancelSession(clientCtx.atlasSessionId);
									}}
								>
									<IconSmall.Stop />
								</button>
							{:else}
								<button type="submit" aria-label="Send message">
									<CustomIcons.ArrowUp />
								</button>
							{/if}
						</div>
					</form>

					<div class="actions">
						<button
							class="file-drop"
							type="button"
							onclick={async (e) => {
								e.preventDefault();

								const paths = await invoke<string[]>('open_file_or_folder_picker', {
									multiple: true,
									foldersOnly: false
								});

								if (paths && paths.length > 0) {
									for (const path of paths) {
										appCtx.stagedFiles.add(path, {
											path,
											type: getFileType(path)
										});
									}
								}
							}}
						>
							<CustomIcons.Paperclip />

							Add Files
						</button>

						<!-- <button
						class="file-drop"
						type="button"
						onclick={async (e) => {
							e.preventDefault();

							// @TODO implement some search examples
						}}
					>
						<CustomIcons.Globe />

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
			</div>

			<div class="background-blur"></div>
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
		z-index: var(--layer-1);
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
		padding-inline: var(--size-1);

		h2 {
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
			margin-block-end: var(--size-2);
		}

		p {
			font-size: var(--font-size-3);
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
		padding-block-end: var(--size-4);
	}

	footer {
		font-size: var(--font-size-1);
		font-weight: var(--font-weight-5);
		opacity: 0.5;
		margin-block-start: auto;
		text-align: center;
		padding-block-end: var(--size-7);
		position: absolute;
		inset-block-end: 0;
		inset-inline: 0;
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
				font-size: var(--font-size-1);
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
			font-size: var(--font-size-1);
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
</style>
