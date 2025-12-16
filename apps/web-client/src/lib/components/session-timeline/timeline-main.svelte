<script lang="ts">
import type {
  SessionHistoryEvent,
  SessionHistoryMetadata,
} from "@atlas/core/session/history-storage";
import type { AgentGroup } from "$lib/utils/session-timeline";
import EventGroup from "./event-group.svelte";

interface Props {
  metadata: SessionHistoryMetadata;
  sessionEvents: SessionHistoryEvent[];
  agentGroups: AgentGroup[];
}

let { agentGroups }: Props = $props();
</script>

<div class="timeline-main">
	{#if agentGroups.length === 0}
		<div class="empty-state">
			<p>No agent executions found for this session.</p>
		</div>
	{:else}
		{#each agentGroups as group (group.executionId)}
			<EventGroup {group} />
		{/each}
	{/if}
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
