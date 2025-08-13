<script lang="ts">
	import { SSEEventSchema, type OutputEntry } from '$lib/modules/messages/types';
	import Button from '$lib/components/button.svelte';
	import { Form } from '$lib/components/form';
	import Body from '$lib/components/page/body.svelte';
	import { ConversationClient } from '$lib/modules/client/conversation.ts';
	import Message from '$lib/modules/messages/message.svelte';

	function getAtlasDaemonUrl() {
		return 'http://localhost:8080';
	}

	let typingState = $state({
		isTyping: false,
		elapsedSeconds: 0
	});

	type SSEMessage = Map<string, ReturnType<typeof SSEEventSchema.parse>>;

	let conversationClient = $state<ConversationClient | null>(null);
	let conversationSessionId = $state<string | null>(null);
	let sseAbortController = $state<AbortController | null>(null);
	let sseStream = $state<AsyncIterable<unknown> | null>(null);
	let initialized = $state(false);
	let messages = $state<SSEMessage>(new Map());
	let output = $state<OutputEntry[]>([]);
	let user = $state<string>();

	function getAuthor(type: ReturnType<typeof SSEEventSchema.parse>['type']) {
		if (type === 'request') {
			return user;
		}

		if (type === 'text') {
			return 'Atlas';
		}

		return undefined;
	}

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

	function formatMessage(
		messages: ReturnType<typeof SSEEventSchema.parse>[]
	): OutputEntry | undefined {
		const firstMessage = messages[0];

		if (!firstMessage) {
			return;
		}

		return {
			id: firstMessage.id,
			type: firstMessage.type,
			timestamp: firstMessage.timestamp,
			author: getAuthor(firstMessage.type),
			content: messages.map((message) => message.data.content).join('')
		};
	}

	function getGroupedMessages(messageValues: ReturnType<typeof SSEEventSchema.parse>[]) {
		// Group messages by ID
		return messageValues.reduce(
			(groups, message) => {
				const id = message.id;
				if (!groups[id]) {
					groups[id] = [];
				}

				groups[id].push(message);

				return groups;
			},
			{} as Record<string, typeof messageValues>
		);
	}

	$effect(() => {
		const initializeSystem = async () => {
			// Prevent multiple initializations
			if (initialized) {
				return;
			}

			initialized = true;

			try {
				// Initialize ConversationClient for system workspace
				try {
					// Use "atlas-conversation" as the workspace ID for the conversation system workspace
					const newConversationClient = new ConversationClient(
						getAtlasDaemonUrl(),
						'atlas-conversation',
						'cli-user'
					);

					const session = await newConversationClient.createSession();

					conversationClient = newConversationClient;
					conversationSessionId = session.sessionId;
					// Store the SSE URL for later use
					newConversationClient.sseUrl = session.sseUrl;

					// Create AbortController for SSE
					const abortController = new AbortController();
					sseAbortController = abortController;
				} catch {
					// Add error handling here if needed
				} finally {
					initialized = true;
				}
			} catch (error) {
				// Clear any loading messages and show error
				const errorMessage = error instanceof Error ? error.message : String(error);

				console.error(`Failed to start Atlas daemon: ${errorMessage}`);

				initialized = false;
			}
		};

		initializeSystem();
	});

	$effect(() => {
		if (!conversationClient || !conversationSessionId || !conversationClient.sseUrl) {
			return;
		}

		// Start SSE stream
		const sseIterator = conversationClient.streamEvents(
			conversationSessionId,
			conversationClient.sseUrl,
			sseAbortController?.signal
		);
		sseStream = sseIterator;

		return () => {
			// Clean up SSE connection
			if (sseAbortController) {
				sseAbortController.abort();
				sseAbortController = null;
			}

			sseStream = null;
		};
	});

	$effect(() => {
		if (!conversationSessionId || sseAbortController?.signal.aborted) {
			return;
		}

		const eventSource = new EventSource(
			`${getAtlasDaemonUrl()}/api/stream/${conversationSessionId}/stream`
		);

		eventSource.onmessage = (event) => {
			try {
				// Parse and validate SSE events with Zod
				const parsedResult = SSEEventSchema.safeParse(JSON.parse(event.data));

				if (!parsedResult.success) {
					return;
				}

				let previousMessages = new Map(messages);

				previousMessages.set(parsedResult.data.timestamp, parsedResult.data);

				messages = previousMessages;

				let newOutput = [] as OutputEntry[];

				const messageValues = Array.from(messages.values());

				// Get the latest message to check if it's streaming
				const latestMessage = messageValues[messageValues.length - 1];

				if (latestMessage?.type === 'request') {
					typingState = {
						isTyping: true,
						elapsedSeconds: 0
					};
				}

				if (latestMessage?.type === 'finish' || latestMessage?.type === 'error') {
					typingState = {
						isTyping: false,
						elapsedSeconds: 0
					};
				}

				const groupedMessages = getGroupedMessages(messageValues);

				newOutput = Object.values(groupedMessages)
					.map(formatMessage)
					.filter((message) => message !== undefined);

				output = newOutput;
			} catch (error) {
				console.warn(error);
			}
		};

		return () => {
			if (eventSource) {
				eventSource.close();
			}
		};
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

<Body>
	<div>
		{#each output as message (message.id)}
			{#if message.type !== 'finish'}
				<Message {message} />
			{/if}
		{/each}
	</div>

	<form
		method="POST"
		onsubmit={async (e) => {
			e.preventDefault();

			if (!conversationClient || !conversationSessionId) {
				return;
			}

			try {
				const formData = new FormData(e.target as HTMLFormElement);
				const message = formData.get('message') as string;

				// Just send the message - the persistent SSE listener will handle the response
				await conversationClient.sendMessage(conversationSessionId, message);

				// The persistent SSE listener will handle the response
			} catch (e) {
				console.error(e);
			}
		}}
	>
		<Form.Textarea name="message" placeholder="Message Atlas..." />

		<Button type="submit">Send Message</Button>
	</form>

	{#if typingState.isTyping}
		<div class="typing">
			Typing... {typingState.elapsedSeconds}s
		</div>
	{/if}
</Body>
