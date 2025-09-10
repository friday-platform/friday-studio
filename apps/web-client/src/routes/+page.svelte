<script lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import Textarea from "src/lib/components/textarea.svelte";
import Artifacts from "src/lib/modules/artifacts/artifacts.svelte";
import { onMount } from "svelte";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import { getClientContext } from "$lib/modules/client/context.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import Table from "$lib/modules/messages/table.svelte";
import WorkspaceSummary from "$lib/modules/messages/workspace-summary.svelte";
import { fade, slide } from "svelte/transition";

const { stagedFiles } = getAppContext();

const ctx = getClientContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let scrollContainer = $state<HTMLDivElement | null>(null);
let userHasScrolled = $state(false);
let animationFrameId = $state<number | null>(null);
let showPlan = $state(false);

onMount(() => {
  if (!ctx.conversationSessionId) {
    ctx.createSession();
  }
});

// Handle Scrolling
function handleScroll() {
  userHasScrolled = true;

  // if (!scrollContainer) return;

  // const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  // const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 50;
  // // If user scrolls away from bottom, mark as manually scrolled
  // if (!isAtBottom) {
  // }
  // // If user scrolls back to bottom, reset the flag
  // if (isAtBottom) {
  // 	userHasScrolled = false;
  // }
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

<div
	class="chat"
	class:has-messages={ctx.messages.filter(
		(m) => m.type !== 'data-connection' && m.type !== 'data-heartbeat'
	).length > 0}
>
	<div class="main">
		<h2>Dashboard</h2>

		{#if ctx.messages.filter((m) => m.type !== 'data-connection' && m.type !== 'data-heartbeat').length === 0}
			<div class="empty-message">
				<p>Welcome to Atlas! What can I help you build?</p>
				<p>Tip: You can drag and drop files to attach them to your message.</p>
			</div>
		{/if}

		<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
			<div class="messages-inner">
				{#each ctx.messages as message, index (message.id || index)}
					{@const formattedMessage = formatMessage(message, ctx.user)}

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
						let formMessage = formData.get('message') as string;

						if (stagedFiles.state.size > 0) {
							formMessage = formMessage + `\n\nAttachments:`;

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
						stagedFiles.clear();

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
					{#if ctx.typingState.isTyping}
						<button
							class="stop-process"
							type="button"
							onclick={async (e) => {
								e.preventDefault();

								if (!ctx.atlasSessionId) return;

								ctx.conversationClient?.cancelSession(ctx.atlasSessionId);
							}}
						>
							<IconSmall.Stop />
						</button>
					{:else}
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
									stagedFiles.add(file[0], {
										path: file[0],
										type: getFileType(file[0])
									});
								}
							}}
						>
							<CustomIcons.Paperclip />
						</button>
					{/if}
				</div>
			</form>

			{#if stagedFiles.state.size > 0}
				<div class="staged-files">
					{#each stagedFiles.state.entries() as [itemId, file]}
						<button
							onclick={async () => {
								stagedFiles.remove(itemId);
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

	{#if showPlan}
	    {@const latestPlanMessage = ctx.messages.findLast(message => message.type === 'tool-workspace_summary')}
		{@const formattedPlan = latestPlanMessage ? formatMessage(latestPlanMessage, ctx.user) : null}
		{#if formattedPlan}
		    {@const data = formattedPlan.metadata?.result}
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
		grid-template-columns: 1fr var(--size-64);
		inline-size: 100%;
		overflow: hidden;
		position: relative;
		transition: all 150ms ease;
		z-index: var(--layer-1);

		.plan {
			background-color: var(--background-1);
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
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-4);
				opacity: 0.7;
			}

			.close-button {
				position: absolute;
				inset-inline-end: var(--size-2);
				inset-block-start: var(--size-2);
			}
		}

		.main {
			display: flex;
			block-size: 100%;
			overflow: hidden;
			flex-direction: column;
			padding-inline-end: var(--size-10);

			h2 {
				font-size: var(--font-size-7);
				font-weight: var(--font-weight-7);
				line-height: var(--font-lineheight-1);
				padding-inline: var(--size-10);
				padding-block-start: var(--size-10);
			}

			.empty-message {
				font-size: var(--font-size-4);
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
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-1);
			}
		}
	}

	.messages {
		flex: 1;
		overflow-y: scroll;
		scrollbar-width: thin;
		padding-block: var(--size-6) var(--size-16);
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
		background-color: var(--background-1);
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
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
				gap: var(--size-1-5);
				inline-size: var(--size-7);
				justify-content: center;
				transition: all 150ms ease;

				&:hover {
					background-color: var(--highlight-1);
				}
			}

			.stop-process {
				align-items: center;
				background-color: var(--accent-1);
				border-radius: var(--radius-2);
				block-size: var(--size-5);
				color: var(--background-1);
				display: flex;
				justify-content: center;
				inline-size: var(--size-5);
				margin-block-start: var(--size-1);
				margin-inline-end: var(--size-1);
				transition: all 150ms ease;

				&:hover {
					opacity: 0.7;
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
					font-size: var(--font-size-0);
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
