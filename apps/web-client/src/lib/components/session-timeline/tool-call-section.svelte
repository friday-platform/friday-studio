<script lang="ts">
import type { SessionHistoryEvent } from "@atlas/core/session/history-storage";
import { createCollapsible } from "@melt-ui/svelte";
import { slide } from "svelte/transition";

interface Props {
  events: SessionHistoryEvent[];
}

let { events }: Props = $props();

// Extract tool calls and results
const toolEvents = $derived.by(() => {
  return events.filter((e) => e.type === "agent-tool-call" || e.type === "agent-tool-result");
});

// Collapsible: default open if 2 or fewer tool calls, closed if more
// Calculate initial state based on tool events length
const initialToolCallCount = events.filter((e) => e.type === "agent-tool-call").length;
const {
  elements: { root, trigger, content },
  states: { open },
} = createCollapsible({ defaultOpen: initialToolCallCount <= 2 });

const toolCallCount = $derived(toolEvents.filter((e) => e.type === "agent-tool-call").length);

const TRUNCATE_LENGTH = 500;

function formatContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content, null, 2);
}

function shouldTruncate(content: string): boolean {
  return content.length > TRUNCATE_LENGTH;
}

// Track expanded state for each tool call/result
let expandedStates = $state<Map<string, boolean>>(new Map());

function toggleExpanded(eventId: string) {
  const current = expandedStates.get(eventId) ?? false;
  expandedStates.set(eventId, !current);
  expandedStates = new Map(expandedStates);
}

function isExpanded(eventId: string): boolean {
  return expandedStates.get(eventId) ?? false;
}
</script>

{#if toolEvents.length > 0}
	<div class="tool-call-section" {...$root} use:root>
		<button class="tool-call-trigger" type="button" {...$trigger} use:trigger>
			<span class="trigger-icon" class:open={$open}>▼</span>
			Tool Calls ({toolCallCount})
		</button>

		{#if $open}
			<div class="tool-call-content" {...$content} use:content transition:slide>
				{#each toolEvents as event (event.eventId)}
					{@const isToolCall = event.type === 'agent-tool-call'}
					{@const isToolResult = event.type === 'agent-tool-result'}

					<div class="tool-event" class:is-call={isToolCall} class:is-result={isToolResult}>
						<div class="event-label">
							{isToolCall ? 'Tool call' : 'Tool result'}
						</div>

						<div class="event-content">
							{#if isToolCall && 'toolCall' in event.data}
								{@const toolCall = event.data.toolCall}
								<div class="tool-name">{toolCall.toolName}</div>
								{#if toolCall.args}
									{@const formatted = formatContent(toolCall.args)}
									{@const needsTruncation = shouldTruncate(formatted)}
									{@const expanded = isExpanded(event.eventId)}
									<pre class="tool-args">{expanded || !needsTruncation
											? formatted
											: formatted.slice(0, TRUNCATE_LENGTH) + '...'}</pre>
									{#if needsTruncation}
										<button class="expand-button" onclick={() => toggleExpanded(event.eventId)}>
											{expanded ? 'Show less' : 'Show more'}
										</button>
									{/if}
								{/if}
							{:else if isToolResult && 'toolResult' in event.data}
								{@const toolResult = event.data.toolResult}
								{#if toolResult.content}
									{@const formatted = formatContent(toolResult.content)}
									{@const needsTruncation = shouldTruncate(formatted)}
									{@const expanded = isExpanded(event.eventId)}
									<pre class="tool-result">{expanded || !needsTruncation
											? formatted
											: formatted.slice(0, TRUNCATE_LENGTH) + '...'}</pre>
									{#if needsTruncation}
										<button class="expand-button" onclick={() => toggleExpanded(event.eventId)}>
											{expanded ? 'Show less' : 'Show more'}
										</button>
									{/if}
								{:else}
									<div class="empty-result">No result content</div>
								{/if}
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.tool-call-section {
		margin-block-start: var(--size-2);
	}

	.tool-call-trigger {
		align-items: center;
		background-color: var(--background-3);
		border: 1px solid var(--border-1);
		border-radius: var(--radius-2);
		color: var(--text-2);
		cursor: pointer;
		display: flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		gap: var(--size-2);
		inline-size: 100%;
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
		text-align: start;
	}

	.tool-call-trigger:hover {
		background-color: var(--background-4);
		border-color: var(--border-2);
	}

	.trigger-icon {
		color: var(--text-3);
		display: inline-block;
		font-size: var(--font-size-2);
		transition: transform 0.2s;
		transform: rotate(-90deg);
	}

	.trigger-icon.open {
		transform: rotate(0deg);
	}

	.tool-call-content {
		display: flex;
		flex-direction: column;
		gap: var(--size-2);
		margin-block-start: var(--size-2);
	}

	.tool-event {
		background-color: var(--background-3);
		border-radius: var(--radius-2);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
	}

	.tool-event.is-call {
		border-inline-start: 2px solid var(--color-blue-3);
	}

	.tool-event.is-result {
		border-inline-start: 2px solid var(--color-teal-3);
	}

	.event-label {
		color: var(--text-3);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		margin-block-end: var(--size-1);
		text-transform: uppercase;
	}

	.event-content {
		color: var(--text-2);
		font-size: var(--font-size-3);
	}

	.tool-name {
		color: var(--text-1);
		font-family: var(--font-family-monospace);
		font-weight: var(--font-weight-6);
		margin-block-end: var(--size-2);
	}

	.tool-args,
	.tool-result {
		background-color: var(--background-4);
		border-radius: var(--radius-1);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
		line-height: var(--font-lineheight-3);
		overflow-x: auto;
		padding-block: var(--size-2);
		padding-inline: var(--size-2);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.expand-button {
		background-color: transparent;
		border: 1px solid var(--border-1);
		border-radius: var(--radius-2);
		color: var(--text-2);
		cursor: pointer;
		font-size: var(--font-size-2);
		margin-block-start: var(--size-2);
		padding-block: var(--size-1);
		padding-inline: var(--size-2);
	}

	.expand-button:hover {
		background-color: var(--background-4);
		border-color: var(--border-2);
	}

	.empty-result {
		color: var(--text-3);
		font-style: italic;
	}
</style>
