<script lang="ts">
import type {
  SessionHistoryEvent,
  SessionHistoryMetadata,
} from "@atlas/core/session/history-storage";
import type { AgentGroup } from "$lib/utils/session-timeline";
import EventGroup from "./event-group.svelte";

// import SessionEvent from "./session-event.svelte";

interface Props {
  metadata: SessionHistoryMetadata;
  sessionEvents: SessionHistoryEvent[];
  agentGroups: AgentGroup[];
}

let {
  // metadata,
  // sessionEvents,
  agentGroups,
}: Props = $props();

// const sessionStart = $derived(sessionEvents.find((e) => e.type === 'session-start'));
// const sessionFinish = $derived(sessionEvents.find((e) => e.type === 'session-finish'));
</script>

<div class="timeline-main">
	<!-- {#if sessionStart}
		<SessionEvent event={sessionStart} {metadata} />
	{/if} -->

	{#if agentGroups.length === 0}
		<div class="empty-state">
			<p>No agent executions found for this session.</p>
		</div>
	{:else}
		{#each agentGroups as group (group.executionId)}
			<EventGroup {group} />
		{/each}
	{/if}

	<!-- {#if sessionFinish}
		<SessionEvent event={sessionFinish} {metadata} />
	{/if} -->
</div>

<style>
	.timeline-main {
		display: flex;
		flex-direction: column;
	}

	.empty-state {
		align-items: center;
		color: var(--text-3);
		display: flex;
		font-size: var(--font-size-3);
		justify-content: center;
		padding-block: var(--size-16);
	}
</style>
