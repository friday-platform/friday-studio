<script lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { onMount } from "svelte";
import { fade } from "svelte/transition";
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
import WorkspaceSummary from "$lib/modules/messages/workspace-summary.svelte";

const appCtx = getAppContext();

const clientCtx = getClientContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let scrollContainer = $state<HTMLDivElement | null>(null);
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);
let showPlan = $state(false);

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

const formattedMessages = $derived(clientCtx.formattedMessages);
const rawMessages = $derived([...clientCtx.messageHistory, ...clientCtx.messages]);

const hasMessages = $derived(formattedMessages.filter((m) => m.type !== "header").length > 0);
</script>

<div class="chat" class:has-messages={hasMessages}>
	<div class="main">
		<div class="messages" class:has-messages={hasMessages}>
			<div class="messages-inner" bind:this={scrollContainer} onscroll={handleScroll}>
				<div class="first-message">
					<h2>Welcome</h2>
					<p>
						I’m Atlas, your automation partner. What can I help you accomplish today? Provide the
						details, and I’ll help you make it happen.
					</p>
				</div>

				{#each formattedMessages as formattedMessage, index (formattedMessage.id || index)}

					{#if formattedMessage && (formattedMessage.type === 'request' || formattedMessage.type === 'text')}
						<Message message={formattedMessage} />
					{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'table_output'}
						<Table data={formattedMessage.metadata?.result} />
					{:else if formattedMessage && formattedMessage.type === 'tool_call' && formattedMessage.metadata?.toolName === 'workspace_summary'}
						<WorkspaceSummary
							data={formattedMessage.metadata?.result}
							onShowPlan={() => (showPlan = true)}
						/>
					{:else if formattedMessage && formattedMessage.type === 'error'}
						<ErrorMessage message={formattedMessage} />
					{/if}
				{/each}

				{#if clientCtx.typingState.isTyping}
					{@const actionsAfterLastUser = (() => {
						// Find the last data-user-message
						const lastUserIndex = rawMessages.findLastIndex(
							(msg) => msg.type === 'data-user-message'
						);

						// If no user message found, return empty
						if (lastUserIndex === -1) return [];

						// Return everything after the last user message
						return rawMessages.slice(lastUserIndex + 1);
					})()}

					<Progress actions={actionsAfterLastUser} />
				{/if}
			</div>
			<div class="interactive-container">
				<div class="interactive-container-int" class:has-messages={hasMessages}>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<form
						bind:this={form}
						title={clientCtx.typingState.isTyping
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
									formMessage &&
									typeof formMessage === 'string' &&
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

	{#if showPlan}
		{@const latestPlanMessage = formattedMessages.findLast(
			(message) => message.type === 'tool_call' && message.metadata?.toolName === 'workspace_summary'
		)}
		{#if latestPlanMessage}
			{@const data = latestPlanMessage.metadata?.result}
			<div class="plan" transition:fade={{ duration: 150 }}>
				<button type="button" class="close-button" onclick={() => (showPlan = false)}>
					<IconSmall.Close />
				</button>
				<h3>Description</h3>

				<p>{data.data.description}</p>

				<h3>Agents</h3>

				<ul>
					{#each data.data.agents as agent}
						<li>{agent}</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
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

		.plan {
			background-color: var(--color-surface-1);
			border-radius: var(--radius-3);
			box-shadow: var(--shadow-1);
			inset-block-start: var(--size-10);
			inset-inline-end: var(--size-10);
			position: absolute;
			inline-size: var(--size-72);
			padding: var(--size-4);
			max-block-size: calc(100dvh - var(--size-20));
			overflow: auto;
			scrollbar-width: thin;
			z-index: var(--layer-5);

			h3 {
				font-weight: var(--font-weight-5);

				&:not(:first-of-type) {
					margin-block-start: var(--size-4);
				}
			}

			p,
			li {
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4);
				opacity: 0.7;
			}

			.close-button {
				position: absolute;
				inset-inline-end: var(--size-2);
				inset-block-start: var(--size-2);
			}
		}
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
		margin-inline: auto;
		max-inline-size: var(--size-150);
		inline-size: 100%;
		padding-inline-start: var(--size-1);

		h2 {
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
			margin-block-end: var(--size-2);
		}

		p {
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-4);
			opacity: 0.8;
			text-wrap: balance;
		}
	}

	.messages {
		align-content: center;
		display: grid;
		block-size: 100%;
		grid-template-rows: 6.25rem 4.625rem;
		padding: var(--size-10);
		padding-block-start: var(--size-10);
		transition: grid-template-rows 150ms ease;

		&.has-messages {
			grid-template-rows:
				calc(100% - 4.625rem)
				4.625rem;
		}

		.messages-inner {
			display: flex;
			flex-direction: column;
			gap: var(--size-4);
			margin-inline: auto;
			max-inline-size: var(--size-150);
			padding-inline: var(--size-1);
			padding-block-end: var(--size-4);
			inline-size: 100%;
			overflow-y: scroll;
			scrollbar-width: none;
		}

		.background-blur {
			background: var(--color-surface-1);
			block-size: var(--size-28);
			inset-block-end: 0;
			inset-inline: 0;
			position: absolute;
			opacity: 1;
			pointer-events: none;
		}
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
		block-size: 4.625rem;
		position: relative;
		margin-inline: auto;
		max-inline-size: var(--size-150);
		inline-size: 100%;
		overflow: visible;
		z-index: var(--layer-2);

		.interactive-container-int {
			position: absolute;
			inset-block-start: 0;
			inline-size: 100%;

			&.has-messages {
				inset-block-start: auto;
				inset-block-end: 0;
			}
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

				.date {
					align-items: center;
					block-size: var(--size-3-5);
					border-radius: var(--radius-1);
					border: 1.5px solid currentColor;
					display: flex;
					font-size: 7px;
					font-weight: 900;
					letter-spacing: calc(-1 * var(--font-letterspacing-2));
					line-height: var(--font-lineheight-0);
					inline-size: var(--size-3-5);
					justify-content: center;
					text-align: center;
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
