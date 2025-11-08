<script lang="ts">
import type {
  SessionHistoryEvent,
  SessionHistoryMetadata,
} from "@atlas/core/session/history-storage";
import EventIcon from "./event-icon.svelte";
import EventTimestamp from "./event-timestamp.svelte";

interface Props {
  event: SessionHistoryEvent;
  metadata: SessionHistoryMetadata;
}

let { event, metadata }: Props = $props();

const isStart = $derived(event.type === "session-start");
const isFinish = $derived(event.type === "session-finish");

const statusIcon = $derived.by(() => {
  if (!isFinish || !("status" in event.data)) {
    return "pending";
  }

  const status = event.data.status;
  if (status === "completed") return "completed";
  if (status === "failed") return "error";
  if (status === "partial") return "partial";
  if (status === "cancelled") return "pending";
  return "pending";
});

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
</script>

<div
	class="session-event"
	class:start={isStart}
	class:finish={isFinish}
	id={isStart ? 'signal' : 'session-finish'}
>
	<div class="event-header">
		{#if isFinish}
			<EventIcon status={statusIcon} />
		{/if}
		<h3 class="event-title">
			{isStart ? 'Session Started' : 'Session Finished'}
		</h3>
		<EventTimestamp timestamp={event.emittedAt} />
	</div>

	<div class="event-details">
		{#if isStart}
			<div class="detail-grid">
				<div class="detail-item">
					<span class="detail-label">Signal</span>
					<span class="detail-value">{metadata.signal.provider.name}</span>
				</div>
				{#if metadata.signal.description}
					<div class="detail-item full-width">
						<span class="detail-label">Description</span>
						<span class="detail-value">{metadata.signal.description}</span>
					</div>
				{/if}
				<div class="detail-item">
					<span class="detail-label">Workspace</span>
					<span class="detail-value">{metadata.workspaceId}</span>
				</div>
				{#if metadata.availableAgents.length > 0}
					<div class="detail-item">
						<span class="detail-label">Available Agents</span>
						<span class="detail-value">{metadata.availableAgents.length}</span>
					</div>
				{/if}
			</div>
		{:else if isFinish && 'status' in event.data}
			<div class="detail-grid">
				<div class="detail-item">
					<span class="detail-label">Status</span>
					<span class="detail-value status-{event.data.status}">{event.data.status}</span>
				</div>
				{#if 'durationMs' in event.data && typeof event.data.durationMs === 'number'}
					<div class="detail-item">
						<span class="detail-label">Duration</span>
						<span class="detail-value">{formatDuration(event.data.durationMs)}</span>
					</div>
				{/if}
				{#if 'summary' in event.data && event.data.summary}
					<div class="detail-item full-width">
						<span class="detail-label">Summary</span>
						<span class="detail-value">{event.data.summary}</span>
					</div>
				{/if}
				{#if 'failureReason' in event.data && event.data.failureReason}
					<div class="detail-item full-width error-reason">
						<span class="detail-label">Failure Reason</span>
						<span class="detail-value">{event.data.failureReason}</span>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.session-event {
		background-color: var(--background-2);
		border: 2px solid var(--border-1);
		border-radius: var(--radius-3);
		padding-block: var(--size-4);
		padding-inline: var(--size-5);
	}

	.session-event.start {
		border-color: var(--color-blue-3);
	}

	.session-event.finish {
		border-color: var(--border-2);
	}

	.event-header {
		align-items: center;
		display: flex;
		gap: var(--size-2);
		margin-block-end: var(--size-4);
	}

	.event-title {
		color: var(--text-1);
		flex: 1;
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-6);
	}

	.event-details {
		display: flex;
		flex-direction: column;
	}

	.detail-grid {
		column-gap: var(--size-6);
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		row-gap: var(--size-3);
	}

	.detail-item {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);
	}

	.detail-item.full-width {
		grid-column: 1 / -1;
	}

	.detail-label {
		color: var(--text-3);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.detail-value {
		color: var(--text-1);
		font-size: var(--font-size-3);
	}

	.error-reason .detail-label {
		color: var(--color-red-3);
	}

	.error-reason .detail-value {
		color: var(--color-red-3);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
	}

	.status-completed {
		color: var(--color-green-3);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.status-failed {
		color: var(--color-red-3);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.status-partial {
		color: var(--color-yellow-3);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.status-cancelled {
		color: var(--text-3);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}
</style>
