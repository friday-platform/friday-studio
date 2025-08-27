<script lang="ts">
import type { SessionUIMessageChunk } from "@atlas/core";
import { readUIMessageStream } from "ai";
import { onDestroy, onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import Button from "$lib/components/button.svelte";
import Dropzone from "$lib/components/dropzone/dropzone.svelte";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import { ConversationClient } from "$lib/modules/client/conversation.ts";
import { formatMessage } from "$lib/modules/messages/format";
import Message from "$lib/modules/messages/message.svelte";
import Progress from "$lib/modules/messages/progress.svelte";
import { type OutputEntry } from "$lib/modules/messages/types";

function getAtlasDaemonUrl() {
  return "http://localhost:8080";
}

const { stagedFiles, daemonClient, uploadFile } = getAppContext();

let form = $state<HTMLFormElement | null>(null);
let message = $state<string>("");
let typingState = $state({ isTyping: false, elapsedSeconds: 0 });
let conversationClient = $state<ConversationClient | null>(null);
let conversationSessionId = $state<string | null>(null);
let sseAbortController = $state<AbortController | null>(null);
let sseStream = $state<ReadableStream<SessionUIMessageChunk> | null>(null);
let output = $state<OutputEntry[]>([]);
let user = $state<string>();

$effect(() => {
  async function getUser() {
    if (!conversationClient || user) {
      return;
    }

    const data = await conversationClient.getUser();

    if (data.success) {
      user = data.currentUser;
    }
  }

  getUser();
});

onMount(async () => {
  try {
    // Use "atlas-conversation" as the workspace ID for the conversation system workspace
    const newConversationClient = new ConversationClient(
      getAtlasDaemonUrl(),
      "atlas-conversation",
      "cli-user",
    );

    const session = await newConversationClient.createSession();

    conversationSessionId = session.sessionId;

    // Store the SSE URL for later use
    newConversationClient.sseUrl = session.sseUrl;
    conversationClient = newConversationClient;

    // Create AbortController for SSE
    sseAbortController = new AbortController();

    const stream = conversationClient.createMessageStream(
      newConversationClient.sseUrl,
      sseAbortController?.signal,
    );

    sseStream = stream;

    for await (const uiMessage of readUIMessageStream({ stream })) {
      uiMessage.parts.forEach((part) => {
        if (part.type === "data-session-start" && !typingState.isTyping) {
          typingState.isTyping = true;
        } else if (part.type === "data-session-finish") {
          typingState.isTyping = false;
        }
      });

      // Process messages with flatMap to handle typing indicator
      output = uiMessage.parts.flatMap((part, index) => {
        const formattedMessage = formatMessage(part, user);

        // If this is a user message, check if there's a text message after it
        if (part.type === "data-user-message") {
          const hasTextAfter = uiMessage.parts
            .slice(index + 1)
            .some((p) => p.type === "text" && p.state === "done");

          // Add typing indicator if no text message follows
          if (!hasTextAfter) {
            return formattedMessage
              ? [
                  formattedMessage,
                  { id: `typing-${uiMessage.id}-${index}`, type: "typing", role: "assistant" },
                ]
              : [];
          }
        }

        return formattedMessage ? [formattedMessage] : [];
      });
    }
  } catch (error) {
    // Clear any loading messages and show error
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(`Failed to start Atlas daemon: ${errorMessage}`);
  }
});

onDestroy(() => {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }

  sseStream = null;
});

$effect(() => {
  let interval: ReturnType<typeof setInterval> | null = null;

  if (typingState.isTyping) {
    interval = setInterval(() => {
      typingState.elapsedSeconds += 1;
    }, 1000);
  } else {
    if (interval) {
      clearInterval(interval);
    }
  }

  return () => {
    if (interval) {
      clearInterval(interval);
    }
  };
});
</script>

<div class="chat" class:has-messages={output.length > 0}>
	<div class="messages">
		<div class="messages-inner">
			{#each output as message (message.id)}
				{#if message.type === 'typing'}
					<!-- Typing indicator found, collect messages between user message and text -->
					{@const intermediateMessages = (() => {
						// Find the current typing indicator's index
						const typingIndex = output.findIndex((msg) => msg.id === message.id);

						// Find the previous request message
						const requestIndex = output.findLastIndex(
							(msg, idx) => idx < typingIndex && msg.type === 'request'
						);

						// Find the next text message (if any)
						const textIndex = output.findIndex(
							(msg, idx) => idx > typingIndex && msg.type === 'text'
						);

						// If no request found, return empty
						if (requestIndex === -1) return [];

						// Collect all messages between request and typing (or text if it exists)
						const endIndex = textIndex !== -1 ? textIndex : typingIndex;

						return output
							.slice(requestIndex + 1, endIndex)
							.filter(
								(msg) => msg.type !== 'typing' && msg.type !== 'request' && msg.type !== 'text'
							);
					})()}

					<Progress actions={intermediateMessages} />
				{:else}
					<!-- Render regular messages (request and text), skip intermediate types -->
					{#if message.type === 'request' || message.type === 'text'}
						<Message {message} />
					{/if}
				{/if}
			{/each}
		</div>
	</div>

	{#if output.length === 0}
		<h2>Welcome to Atlas</h2>
	{/if}

	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<form
		bind:this={form}
		method="POST"
		onkeydown={(e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.currentTarget?.requestSubmit();
			}
		}}
		onsubmit={async (e) => {
			e.preventDefault();

			if (!conversationClient || !conversationSessionId) {
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

				// Just send the message - the persistent SSE listener will handle the response
				await conversationClient.sendMessage(conversationSessionId, formMessage);

				message = '';

				// The persistent SSE listener will handle the response
			} catch (e) {
				console.error(e);
			}
		}}
	>
		<textarea name="message" placeholder="What can I help you with?" bind:value={message}
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
						<span>Upload Files</span>
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
				inline-size: 94px;
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
</style>
