<script lang="ts">
import { createCollapsible } from "@melt-ui/svelte";
import { get } from "svelte/store";
import { slide } from "svelte/transition";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import { formatDuration } from "$lib/utils/date";
import type { AgentGroup } from "$lib/utils/session-timeline";
import EventItem from "./event-item.svelte";
import ToolCallSection from "./tool-call-section.svelte";

interface Props {
  group: AgentGroup;
}

let { group }: Props = $props();

// Computes a duration string representing how long this agent group ran.
// Returns null if there are fewer than 2 events (not enough data).
const duration = $derived.by(() => {
  if (group.events.length < 2) return null; // Need at least start and end events

  const start = new Date(group.startedAt).getTime(); // Epoch ms of group start
  const end = new Date(group.events[group.events.length - 1].emittedAt).getTime(); // Last event time
  return formatDuration(start, end);
});

// Separate tool events from other events
const nonToolEvents = $derived(
  group.events.filter((e) => e.type !== "agent-tool-call" && e.type !== "agent-tool-result"),
);

// Collapsible: default open for agent groups
const {
  elements: { trigger },
  states: { open },
} = createCollapsible({ defaultOpen: false });

const formatted = $derived.by(() => {
  const date = new Date(group.startedAt);
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
});
</script>

<div class="event-group" id={group.executionId} class:open={get(open)}>
	<button class="summary" type="button" {...get(trigger)} use:trigger>
		<div class="content">
			<span class="title">
				{#if group.status === 'completed'}
					<span style:color="var(--color-green-2)">
						<IconSmall.Check />
					</span>
				{:else if group.status === 'error'}
					<span style:color="var(--color-red)">
						<IconSmall.Close />
					</span>
				{:else}
					<IconSmall.Progress />
				{/if}
				{group.agentId}
			</span>

			<p class="details">
				{#if group.status === 'completed'}
					Succeeded
				{:else if group.status === 'error'}
					Failed
				{:else}
					In Progress
				{/if}

				• Started at <time datetime={group.startedAt} title={group.startedAt}>{formatted}</time>
				{#if duration !== null}
					• Took <time class="duration" datetime="{duration} seconds">{duration}</time>
				{/if}
			</p>
		</div>

		<span class="trigger-icon" class:open={$open}><Icons.TriangleRight /></span>
	</button>

	{#if $open}
		<div class="group-events" transition:slide={{ duration: 250 }}>
			{#each nonToolEvents as event (event.eventId)}
				<EventItem {event} />
			{/each}
			<ToolCallSection events={group.events} />
		</div>
	{/if}
</div>

<style>
	.event-group {
		border-block-end: var(--size-px) solid var(--color-border-2);
		margin-inline: calc(var(--size-3) * -1) calc(var(--size-2) * -1);
	}

	.summary {
		align-items: center;
		background-color: transparent;
		block-size: var(--size-16);
		border: none;
		border-block-end: 1px solid var(--border-1);
		cursor: pointer;
		display: flex;
		gap: var(--size-1);
		justify-content: space-between;
		inline-size: 100%;
		text-align: start;
		padding-inline: var(--size-3) var(--size-2);
		position: relative;

		&:focus {
			outline: none;
		}

		&:before {
			background-color: var(--color-surface-2);
			border-radius: var(--size-3);
			content: '';
			inset: 0;
			position: absolute;
			transition: all 150ms ease;
			opacity: 0;
			z-index: -1;
		}

		&:first-of-type:before {
			inset-block-start: var(--size-1);
		}
	}

	.event-group:not(.open) {
		.summary:focus-visible,
		.summary:hover {
			border-color: transparent;

			&:before {
				opacity: 1;
			}
		}

		&:has(.summary:hover),
		&:has(.summary:focus-visible) {
			border-color: transparent;
		}
	}

	.event-group {
		&:has(+ .event-group:not(.open) .summary:hover),
		&:has(+ .event-group:not(.open) .summary:focus-visible) {
			border-color: transparent;
		}
	}

	.content {
		display: flex;
		flex-direction: column;
	}

	.trigger-icon {
		opacity: 0.4;
		margin-inline-end: var(--size-2);
		transition: transform 0.2s;
	}

	.trigger-icon.open {
		transform: rotate(90deg);
	}

	.title {
		align-items: center;
		display: flex;
		gap: var(--size-1);
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
	}

	.details {
		font-size: var(--font-size-2);
		opacity: 0.7;
	}

	.group-events {
		display: flex;
		flex-direction: column;
		gap: var(--size-3);
		padding-block-end: var(--size-3);
	}
</style>
