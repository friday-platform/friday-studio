<script lang="ts">
import type { SessionHistoryEvent } from "@atlas/core/session/history-storage";
import AgentEvent from "./agent-event.svelte";
import PhaseEvent from "./phase-event.svelte";
import ValidationEvent from "./validation-event.svelte";

interface Props {
  event: SessionHistoryEvent;
}

let { event }: Props = $props();
</script>

{#if event.type === 'agent-start' || event.type === 'agent-output' || event.type === 'agent-error'}
	<AgentEvent {event} />
{:else if event.type === 'validation-result'}
	<ValidationEvent {event} />
{:else if event.type === 'phase-start' || event.type === 'phase-complete'}
	<PhaseEvent {event} />
{:else if event.type === 'agent-tool-call' || event.type === 'agent-tool-result'}
	<!-- Tool events are handled by ToolCallSection in event-group.svelte -->
	<!-- This branch should never be reached as tool events are filtered out -->
{:else}
	<div class="generic-event">
		<div class="event-type">{event.type}</div>
		<pre class="event-data">{JSON.stringify(event.data, null, 2)}</pre>
	</div>
{/if}

<style>
	.generic-event {
		border: 1px solid var(--border-1);
		border-radius: var(--radius-2);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
	}

	.event-type {
		color: var(--text-2);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		margin-block-end: var(--size-2);
	}

	.event-data {
		color: var(--text-3);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
		overflow-x: auto;
	}
</style>
