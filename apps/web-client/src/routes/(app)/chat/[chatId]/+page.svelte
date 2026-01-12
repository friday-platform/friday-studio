<script lang="ts">
import { Chat } from "@ai-sdk/svelte";
import { type AtlasUIMessagePart } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { DefaultChatTransport } from "ai";
import { onMount, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { afterNavigate, beforeNavigate } from "$app/navigation";
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
import { getDatetimeContext } from "$lib/utils/date";
import { shareChat } from "$lib/utils/share-chat";
import type { PageData } from "./$types";

/**
 * Formats a file size in bytes to a human-readable string.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const { data }: { data: PageData } = $props();

// Expose artifacts map to child components via context
const ARTIFACTS_KEY = Symbol.for("artifacts");
setContext(ARTIFACTS_KEY, data.artifacts);

const appCtx = getAppContext();
const chatContext = getChatContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
//
let textareaAdditionalSize = $state(1);

// Follow scroll handling
let scrollContainer = $state<HTMLDivElement | null>(null);
let showContents = $state(false);

function setup() {
  if (!chatContext.chats.has(data.chatId)) {
    chatContext.chats.set(
      data.chatId,
      new Chat({
        id: data.chatId,
        messages: data.messages,
        transport: new DefaultChatTransport({
          api: `${getAtlasDaemonUrl()}/api/chat`,
          prepareSendMessagesRequest({ messages, id }) {
            return { body: { message: messages.at(-1), id, datetime: getDatetimeContext() } };
          },
        }),
      }),
    );
  }

  userHasScrolled = false;

  setTimeout(() => {
    showContents = true;
  }, 100);
}

beforeNavigate(() => {
  showContents = false;
});

afterNavigate(setup);

onMount(async () => {
  setup();

  // Handle OAuth return flow
  const url = new URL(window.location.href);
  const credentialId = url.searchParams.get("credential_id");

  if (credentialId && chatContext.chats.has(data.chatId)) {
    try {
      const result = await parseResult(
        client.link.v1.credentials[":id"].$get({ param: { id: credentialId } }),
      );

      if (result.ok) {
        const { provider } = result.data;
        chatContext.chats
          .get(data.chatId)
          ?.sendMessage({
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
function continuouslyScrollToBottom() {
  if (!scrollContainer) return;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
  animationFrameId = requestAnimationFrame(continuouslyScrollToBottom);
}

// Auto-scroll when new messages are added, unless user has manually scrolled
$effect(() => {
  if (!showContents) return;

  if (userHasScrolled && animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (!userHasScrolled && !animationFrameId) {
    animationFrameId = requestAnimationFrame(continuouslyScrollToBottom);
  }
});

// Scroll to the bottom of the container
function scrollToBottom() {
  if (!scrollContainer) return;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

let actionsAfterLastUser = $state<{ parts: AtlasUIMessagePart[] }>({ parts: [] });

$effect(() => {
  const lastAssistantMessage = (chatContext.chats.get(data.chatId)?.messages ?? []).findLast(
    (msg) => msg.role === "assistant",
  );

  // If no user message found, return empty
  if (!lastAssistantMessage) {
    actionsAfterLastUser = { parts: [] };
    return;
  }

  actionsAfterLastUser = { parts: lastAssistantMessage.parts };
});

let showDetails = new SvelteMap<string, boolean>();
</script>

{#if chatContext.chats.has(data.chatId)}
	<div class="chat" class:visible={showContents}>
		<div class="main">
			<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
				<div
					class="messages-container"
					style:--additional-padding="{textareaAdditionalSize}px"
					class:has-outline={chatContext.chats
						.get(data.chatId)
						?.messages.some((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
				>
					<div class="messages-inner">
						<div class="first-message">
							<h2>{data.title ?? 'Untitled'}</h2>
						</div>

						{#each chatContext.chats.get(data.chatId)?.messages as messageContainer, index ((messageContainer.id, index))}
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
											{:else if message.type === 'tool_call' && message.metadata?.toolName === 'connect_service'}
												{@const currentChat = chatContext.chats.get(data.chatId)}
												{#if currentChat}
													<ConnectService
														provider={message.metadata.provider as string}
														chat={currentChat}
													/>
												{/if}
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

						{#if chatContext.chats.get(data.chatId)?.status === 'streaming' || chatContext.chats.get(data.chatId)?.status === 'submitted'}
							<Progress actions={actionsAfterLastUser.parts} />
						{/if}
					</div>

					<Outline
						messages={(chatContext.chats.get(data.chatId)?.messages ?? [])
							.filter((msg) => msg.role === 'assistant')
							.filter((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
					/>
				</div>

				<div class="spacer"></div>

				<div
					class="interactive-container"
					role="region"
					aria-label="Drag and drop files to attach them to your conversation"
					class:has-outline={chatContext.chats
						.get(data.chatId)
						?.messages.some((msg) => msg.parts.some((part) => part.type === 'data-outline-update'))}
					ondragover={(e) => e.preventDefault()}
					ondrop={(e) => {
						e.preventDefault();
						handleFileDrop(appCtx, Array.from(e.dataTransfer?.files ?? []), data.chatId);
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

								if (chatContext.chats.has(data.chatId) && message.trim()) {
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

									chatContext.chats.get(data.chatId)?.sendMessage({ text: combinedMessage });
									message = '';
									appCtx.stagedFiles.clear();

									userHasScrolled = false;
									scrollToBottom();
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

												{@const currentChatMessages =
													chatContext.chats.get(data.chatId)?.messages ?? []}
												{#if currentChatMessages.length > 0}
													<DropdownMenu.Item
														onclick={async () => {
															const messages = chatContext.chats.get(data.chatId)?.messages;
															if (messages) {
																const chatTitle =
																	chatContext.recentChats.find((c) => c.id === data.chatId)
																		?.title ?? 'Untitled';

																await shareChat(messages, chatTitle);
															}
														}}
													>
														Share
													</DropdownMenu.Item>
												{/if}

												<DropdownMenu.Separator />

												<DropdownMenu.Item
													onclick={() => {
														chatContext.resetNewChat();
													}}
												>
													New Chat
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
									onResize={(value) => {
										textareaAdditionalSize = value - 40;
									}}
								/>

								<div class="form-action">
									{#if chatContext.chats.get(data.chatId)?.status === 'streaming' || chatContext.chats.get(data.chatId)?.status === 'submitted'}
										<button
											class="stop-process"
											type="button"
											onclick={async (e) => {
												e.preventDefault();

												chatContext.chats.get(data.chatId)?.stop();
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
				</div>

				<ChatBufferBlur />
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
		opacity: 0;
		position: relative;
		transition: all 200ms ease;
		z-index: var(--layer-0);

		&.visible {
			opacity: 1;
		}
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
		padding-block: 0 var(--size-16);
		position: relative;
		scrollbar-width: thin;
		/* scroll-behavior: smooth; */
	}

	.spacer {
		flex: 1;
	}

	.messages-container {
		display: grid;
		grid-template-columns: 1fr 0;
		padding-block: var(--size-10) calc(var(--size-16) + var(--additional-padding, 0));
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
		inset-inline-end: var(--size-1-5);
		position: fixed;
		transition: all 450ms ease-in-out;
		z-index: var(--layer-2);

		&.has-outline {
			inset-inline-end: calc(var(--size-56));
		}

		.interactive-container-int {
			margin-inline: auto;
			max-inline-size: var(--size-160);
			padding-inline: var(--size-8);
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
</style>
