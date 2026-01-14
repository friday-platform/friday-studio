<script lang="ts">
import type { ReasoningResultStatusType } from "@atlas/core";
import { IconSmall } from "$lib/components/icons/small";

type Props = {
  job: string;
  summary: string;
  workspaceName?: string;
  sessionType?: "conversation" | "task";
  title?: string;
  parentTitle?: string;
  status?: ReasoningResultStatusType;
};

let { job, summary, workspaceName, sessionType, title, parentTitle, status }: Props = $props();

// parentStreamId is available for navigation but not currently used in this display component

const isFailed = $derived(status === "failed");
const isRunning = $derived(status === "partial");
const isTask = $derived(sessionType === "task");
// Show title if available, otherwise fall back to workspace/job name
const displayName = $derived(
  isTask ? `Task: ${title ?? parentTitle ?? "Conversation"}` : (title ?? workspaceName ?? job),
);
</script>

<div class="component">
	<div class="header">
		<div class="group author">
			{displayName}
			{#if isRunning}
				<span class="running-tag">
					<IconSmall.Progress />
					Running
				</span>
			{:else if isFailed}
				<span class="failed-tag">
					<IconSmall.Close />
					Failed
				</span>
			{/if}
		</div>
	</div>

	<div class="details">
		<span class="message">{summary}</span>
	</div>
</div>

<style>
	.component {
		overflow: hidden;
	}

	.header {
		align-items: center;
		display: flex;
		font-weight: var(--font-weight-5);
		gap: var(--size-2);
		justify-content: start;
		inline-size: 100%;
		overflow: hidden;
	}

	.details {
		align-items: center;
		display: flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		opacity: 0.7;
		margin-block-start: var(--size-0-5);
	}

	.author {
		flex: none;
	}

	.group {
		align-items: center;
		display: flex;
		gap: var(--size-1);
		justify-content: start;
		overflow: hidden;
		text-overflow: ellipsis;

		& :global(svg) {
			flex: none;
		}
	}

	.message {
		font-weight: var(--font-weight-4);
		max-inline-size: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.failed-tag {
		align-items: center;
		background: color-mix(in srgb, var(--color-red) 7%, transparent);
		border-radius: var(--radius-2-5);
		color: var(--color-red);
		display: inline-flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		margin-inline-start: var(--size-2);
		padding-block: var(--size-0-5);
		padding-inline: var(--size-1-5) var(--size-2);
	}

	.running-tag {
		align-items: center;
		background: color-mix(in srgb, var(--color-yellow) 10%, transparent);
		border-radius: var(--radius-2-5);
		color: var(--color-yellow-2);
		display: inline-flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		margin-inline-start: var(--size-2);
		padding-block: var(--size-0-5);
		padding-inline: var(--size-1-5) var(--size-2);
	}
</style>
