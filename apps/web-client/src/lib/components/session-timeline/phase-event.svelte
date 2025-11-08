<script lang="ts">
import type { SessionHistoryEvent } from "@atlas/core/session/history-storage";

interface Props {
  event: SessionHistoryEvent;
}

let { event }: Props = $props();

const isStart = $derived(event.type === "phase-start");
const isComplete = $derived(event.type === "phase-complete");

const phaseDetails = $derived.by(() => {
  if (isComplete && "durationMs" in event.data && typeof event.data.durationMs === "number") {
    return {
      duration: Math.round(event.data.durationMs / 1000),
      issues: "issues" in event.data && Array.isArray(event.data.issues) ? event.data.issues : null,
    };
  }
  return null;
});
</script>

<div class="phase-event" class:start={isStart} class:complete={isComplete}>
	<div class="event-label">
		{isStart ? 'Phase started' : 'Phase completed'}
	</div>

	<div class="event-content">
		{#if isStart && 'name' in event.data}
			<div class="phase-name">{event.data.name}</div>
			<div class="phase-details">
				{#if 'executionStrategy' in event.data}
					<span class="phase-strategy">{event.data.executionStrategy}</span>
				{/if}
				{#if 'agents' in event.data && Array.isArray(event.data.agents) && event.data.agents.length > 0}
					<span class="phase-agents"
						>{event.data.agents.length} {event.data.agents.length === 1 ? 'agent' : 'agents'}</span
					>
				{/if}
			</div>
			{#if 'reasoning' in event.data && event.data.reasoning}
				<div class="phase-reasoning">{event.data.reasoning}</div>
			{/if}
		{:else if isComplete && 'status' in event.data}
			<div class="phase-complete-info">
				<span class="phase-status status-{event.data.status}">{event.data.status}</span>
				{#if phaseDetails}
					<span class="phase-duration">{phaseDetails.duration}s</span>
				{/if}
			</div>
			{#if phaseDetails?.issues && phaseDetails.issues.length > 0}
				<div class="phase-issues">
					<div class="issues-label">Issues:</div>
					<ul class="issues-list">
						{#each phaseDetails.issues as issue}
							<li>{issue}</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.phase-event {
		border-inline-start: 2px solid var(--color-purple-3);
		padding-inline-start: var(--size-3);
	}

	.phase-event.start {
		border-inline-start-color: var(--color-purple-3);
	}

	.phase-event.complete {
		border-inline-start-color: var(--color-teal-3);
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

	.phase-name {
		color: var(--text-1);
		font-weight: var(--font-weight-6);
		margin-block-end: var(--size-1);
	}

	.phase-details {
		align-items: center;
		color: var(--text-3);
		display: flex;
		font-size: var(--font-size-2);
		gap: var(--size-2);
		margin-block-end: var(--size-2);
	}

	.phase-strategy {
		background-color: var(--background-3);
		border-radius: var(--radius-1);
		padding-block: var(--size-0-5);
		padding-inline: var(--size-1);
		text-transform: capitalize;
	}

	.phase-agents {
		font-family: var(--font-family-monospace);
	}

	.phase-reasoning {
		color: var(--text-3);
		font-size: var(--font-size-2);
		font-style: italic;
		margin-block-start: var(--size-1);
	}

	.phase-complete-info {
		align-items: center;
		display: flex;
		gap: var(--size-2);
	}

	.phase-status {
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.status-completed {
		color: var(--color-green-3);
	}

	.status-failed {
		color: var(--color-red-3);
	}

	.status-partial {
		color: var(--color-yellow-3);
	}

	.status-cancelled {
		color: var(--text-3);
	}

	.phase-duration {
		color: var(--text-3);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
	}

	.phase-issues {
		background-color: var(--background-3);
		border-inline-start: 2px solid var(--color-red-3);
		border-radius: var(--radius-1);
		margin-block-start: var(--size-2);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
	}

	.issues-label {
		color: var(--text-2);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		margin-block-end: var(--size-1);
	}

	.issues-list {
		color: var(--text-3);
		font-size: var(--font-size-2);
		line-height: var(--font-lineheight-3);
		list-style-position: inside;
		margin: 0;
		padding: 0;
	}

	.issues-list li {
		margin-block-end: var(--size-0-5);
	}

	.issues-list li:last-child {
		margin-block-end: 0;
	}
</style>
