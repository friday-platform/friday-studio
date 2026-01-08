<script lang="ts">
import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { onMount } from "svelte";
import { circOut } from "svelte/easing";
import { SvelteMap } from "svelte/reactivity";
import { slide } from "svelte/transition";
import { getAppContext, handleFileDrop } from "$lib/app-context.svelte";
import { getChatContext } from "$lib/chat-context.svelte";
import ChatBufferBlur from "$lib/components/chat-buffer-blur.svelte";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import Textarea from "$lib/components/textarea.svelte";
import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
import Outline from "$lib/modules/conversation/outline.svelte";
import ConnectService from "$lib/modules/messages/connect-service.svelte";
import CredentialLinked from "$lib/modules/messages/credential-linked.svelte";
import ErrorMessage from "$lib/modules/messages/error-message.svelte";
import { formatMessage } from "$lib/modules/messages/format";
import Progress from "$lib/modules/messages/progress.svelte";
import Reasoning from "$lib/modules/messages/reasoning.svelte";
import Request from "$lib/modules/messages/request.svelte";
import Response from "$lib/modules/messages/response.svelte";
import ShowDetails from "$lib/modules/messages/show-details.svelte";
import { formatChatDate } from "$lib/utils/date";

/**
 * Formats a file size in bytes to a human-readable string.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const appCtx = getAppContext();
const chatContext = getChatContext();

// Handle OAuth return flow
onMount(async () => {
  const url = new URL(window.location.href);
  const credentialId = url.searchParams.get("credential_id");

  if (credentialId) {
    try {
      const result = await parseResult(
        client.link.v1.credentials[":id"].$get({ param: { id: credentialId } }),
      );

      if (result.ok) {
        const { provider } = result.data;
        chatContext.newChat.sendMessage({
          parts: [{ type: "data-credential-linked", data: { provider, displayName: provider } }],
        });
      }
    } catch (error) {
      console.error("Failed to fetch credential details:", error);
    } finally {
      // Clean URL params
      url.searchParams.delete("credential_id");
      window.history.replaceState({}, "", url.toString());
    }
  }
});

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let showChats = $state(false);

let actionsAfterLastUser = $state<{ parts: AtlasUIMessagePart[]; timestamp?: string }>({
  parts: [],
});

$effect(() => {
  const lastAssistantMessage = chatContext.newChat.messages.findLast(
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
		<div class="messages" class:has-messages={chatContext.newChat.messages.length > 0}>
			<div
				class="messages-container"
				class:has-outline={chatContext.newChat.messages.some((msg) =>
					msg.parts.some((part) => part.type === 'data-outline-update')
				)}
			>
				<div class="messages-inner">
					{#if chatContext.newChat.messages.length === 0}
						<div class="first-message">
							<p>What would you like to work on today?</p>
						</div>
					{/if}

					{#each chatContext.newChat.messages as messageContainer (messageContainer.id)}
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
										{:else if message.type === 'tool_call' && message.metadata?.toolName === 'connect_service' && message.metadata?.provider}
											<ConnectService
												provider={message.metadata.provider as string}
												chat={chatContext.newChat}
											/>
										{:else if message.type === 'credential_linked'}
											<CredentialLinked {message} />
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

					{#if chatContext.newChat.status === 'streaming' || chatContext.newChat.status === 'submitted'}
						<Progress
							actions={actionsAfterLastUser.parts}
							timestamp={actionsAfterLastUser.timestamp}
						/>
					{/if}
				</div>

				<Outline
					messages={(chatContext.newChat.messages ?? [])
						.filter((msg) => msg.role === 'assistant')
						.filter((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
				/>
			</div>

			<div class="spacer"></div>

			<div
				role="region"
				aria-label="Drag and drop files to attach them to your conversation"
				class="interactive-container"
				class:has-outline={chatContext.newChat.messages.some((msg) =>
					msg.parts.some((part) => part.type === 'data-outline-update')
				)}
				ondragover={(e) => e.preventDefault()}
				ondrop={(e) => {
					e.preventDefault();
					handleFileDrop(appCtx, Array.from(e.dataTransfer?.files ?? []));
				}}
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

							// Check if still uploading
							const hasUploadingFiles = Array.from(appCtx.stagedFiles.state.values()).some(
								(f) => f.status === 'uploading'
							);
							if (hasUploadingFiles) return;

							if (message.trim() && chatContext.newChat) {
								// Build message with ready attachments only
								let combinedMessage = message;
								const readyFiles = Array.from(appCtx.stagedFiles.state.values()).filter(
									(f) => f.status === 'ready' && f.artifactId
								);

								if (readyFiles.length > 0) {
									combinedMessage += '\n\nAttachments:';
									for (const file of readyFiles) {
										combinedMessage += `\n- artifact:${file.artifactId}`;
									}
								}

								chatContext.newChat.sendMessage({ text: combinedMessage });
								message = '';
								appCtx.stagedFiles.clear();
							}
						}}
					>
						{#if appCtx.stagedFiles.state.size > 0}
							<div class="staged-files">
								{#each appCtx.stagedFiles.state.entries() as [itemId, file] (itemId)}
									<button
										class="staged-file"
										class:uploading={file.status === 'uploading'}
										class:ready={file.status === 'ready'}
										class:error={file.status === 'error'}
										title={file.error || file.name}
										onclick={() => {
											if (file.status !== 'uploading') {
												appCtx.stagedFiles.remove(itemId);
											}
										}}
										disabled={file.status === 'uploading'}
									>
										{#if file.status === 'uploading'}
											<span class="status-icon spinning"><IconSmall.Progress /></span>
										{:else if file.status === 'ready'}
											<span class="status-icon"><IconSmall.Check /></span>
										{:else if file.status === 'error'}
											<span class="status-icon"><IconSmall.InfoCircled /></span>
										{/if}

										<span class="file-name">{file.name}</span>

										{#if file.status === 'error'}
											<span class="error-text">{file.error}</span>
										{:else}
											<span class="file-size">{formatFileSize(file.size)}</span>
										{/if}

										{#if file.status !== 'uploading'}
											<span class="close-button">
												<IconSmall.Close />
											</span>
										{/if}
									</button>
								{/each}
							</div>
						{/if}

						<div class="textarea-container">
							<div class="actions">
								<DropdownMenu.Root
									positioning={{
										placement: 'top-start',
										gutter: 0,
										offset: { crossAxis: -6, mainAxis: 12 }
									}}
								>
									{#snippet children(open)}
										<DropdownMenu.Trigger>
											<div class="action-trigger">
												<Icons.Plus />
											</div>
										</DropdownMenu.Trigger>
										<DropdownMenu.Content>
											<DropdownMenu.Item
												closeOnClick={false}
												fileInput={{
													onchange: (files) => {
														handleFileDrop(appCtx, files);
														open.set(false);
													},
													multiple: true
												}}
											>
												Add Files
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									{/snippet}
								</DropdownMenu.Root>
							</div>

							<Textarea
								name="message"
								placeholder="Type here..."
								value={message}
								onTextChange={(value) => {
									message = value;
								}}
							/>

							<div class="form-action">
								{#if chatContext.newChat.status === 'streaming' || chatContext.newChat.status === 'submitted'}
									<button
										class="stop-process"
										type="button"
										onclick={async (e) => {
											e.preventDefault();

											chatContext.newChat.stop();
										}}
									>
										<IconSmall.Stop />
									</button>
								{:else}
									{@const hasUploadingFiles = Array.from(appCtx.stagedFiles.state.values()).some(
										(f) => f.status === 'uploading'
									)}
									<button type="submit" aria-label="Send message" disabled={hasUploadingFiles}>
										<Icons.ArrowUp />
									</button>
								{/if}
							</div>
						</div>
					</form>
				</div>

				{#if chatContext.newChat.messages.length === 0 && chatContext.recentChats.length > 0}
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
									<a class="chat-item" href="/chat/{chat.id}">
										<span class="chat--title">{chat.title || '(Untitled)'}</span>
										<span class="chat--date" title={new Date(chat.updatedAt).toLocaleString()}
											>{formatChatDate(chat.updatedAt)}</span
										>
									</a>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>

			{#if chatContext.newChat.messages.length > 0}
				<ChatBufferBlur />
			{/if}
		</div>

		{#if chatContext.newChat.messages.length === 0}
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
		p {
			font-size: var(--font-size-8);
			font-weight: var(--font-weight-5);
			text-align: center;
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
		inline-size: 100%;
		display: flex;
		flex-direction: column;
		justify-content: start;
		gap: var(--size-3);
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

		inline-size: 100%;
		inset-block-end: 0;
		margin-block-end: auto;
		margin-inline: auto;
		max-inline-size: var(--size-160);
		overflow: visible;
		padding-inline: var(--size-8);
		position: sticky;
		transform: translateY(var(--local__translate-y));
		z-index: var(--layer-2);

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
			border-radius: var(--radius-6);
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

				&:hover:not(:disabled) {
					background-color: var(--color-text);
					@media (prefers-color-scheme: dark) {
						color: var(--color-surface-1);
					}
				}

				&:disabled {
					opacity: 0.5;
					cursor: not-allowed;
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

		.staged-file {
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
			transition: all 150ms ease;

			&.uploading {
				opacity: 0.7;
				cursor: wait;
			}

			&.ready {
				border-color: var(--color-success, #22c55e);

				.status-icon {
					color: var(--color-success, #22c55e);
				}
			}

			&.error {
				border-color: var(--color-error, #ef4444);
				color: var(--color-error, #ef4444);

				.status-icon {
					color: var(--color-error, #ef4444);
				}
			}

			.status-icon {
				flex: none;
				display: flex;
				align-items: center;

				&.spinning {
					animation: spin 1s linear infinite;
				}
			}

			.file-name {
				text-overflow: ellipsis;
				overflow: hidden;
				white-space: nowrap;
				flex: 1;
				opacity: 0.7;
			}

			.file-size {
				font-size: var(--font-size-0);
				opacity: 0.5;
				flex: none;
			}

			.error-text {
				font-size: var(--font-size-0);
				opacity: 0.8;
				flex: none;
				max-inline-size: var(--size-24);
				text-overflow: ellipsis;
				overflow: hidden;
				white-space: nowrap;
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

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
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
			a {
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
