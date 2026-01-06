<script lang="ts">
import { IconSmall } from "$lib/components/icons/small";
import TimelineMain from "$lib/components/session-timeline/timeline-main.svelte";
import { formatSessionDate } from "$lib/utils/date";
import { parseSessionTimeline } from "$lib/utils/session-timeline";
import Breadcrumbs from "../(components)/breadcrumbs.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

const session = $derived(data.session);
const sessionDate = $derived(formatSessionDate(session.metadata.createdAt));
const timelineData = $derived(parseSessionTimeline(session.metadata, session.events));
</script>

<Breadcrumbs {session} />

<div class="page">
	<div class="content">
		<span
			class="status"
			class:completed={data.session.metadata.status === 'completed'}
			class:failed={data.session.metadata.status === 'failed'}
			class:pending={data.session.metadata.status === 'partial'}
		>
			{#if data.session.metadata.status === 'completed'}
				<IconSmall.Check />
				Complete
			{:else if data.session.metadata.status === 'failed'}
				<IconSmall.Close />
				Failed
			{:else if data.session.metadata.status === 'partial'}
				<IconSmall.Progress />
				In Progress
			{/if}
		</span>

		<h1>{data.session.metadata.title ?? data.session.metadata.sessionId}</h1>

		<time
			title={data.session.metadata.createdAt}
			datetime={data.session.metadata.createdAt}
			class="session-date">{sessionDate}</time
		>

		<div class="details">
			<h2>Summary</h2>

			<p>{data.session.metadata.summary}</p>

			<h2>Details</h2>

			<TimelineMain
				metadata={timelineData.metadata}
				sessionEvents={timelineData.sessionEvents}
				agentGroups={timelineData.agentGroups}
			/>
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		block-size: 100%;
		inline-size: 100%;
		overflow: scroll;
		scrollbar-width: thin;
	}

	.content {
		flex: 1;
		padding-block: var(--size-12);
		padding-inline: var(--size-14);
	}

	h1 {
		font-size: var(--font-size-8);
		font-weight: var(--font-weight-7);
		margin-block: var(--size-3) var(--size-1);
		line-height: var(--font-lineheight-1);
	}

	.session-date {
		color: var(--color-text);
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-5);
		line-height: var(--font-lineheight-1);
		opacity: 0.7;
	}

	.status {
		align-items: center;
		border-radius: var(--radius-2-5);
		border: 1px solid transparent;
		block-size: var(--size-5-5);
		color: var(--color-text-2);
		display: flex;
		gap: var(--size-1);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		inline-size: fit-content;
		padding-inline: var(--size-1-5) var(--size-2);

		&.completed {
			background: color-mix(in srgb, var(--color-green) 7%, transparent);
			color: var(--color-green-2);
		}

		&.failed {
			background: color-mix(in srgb, var(--color-red) 7%, transparent);
			color: var(--color-red);
		}

		&.pending {
			background: color-mix(in srgb, var(--color-yellow) 10%, transparent);
			color: var(--color-yellow-2);
		}
	}

	.details {
		padding-block-start: var(--size-10);

		h2 {
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-1);
			opacity: 0.7;

			&:not(:first-child) {
				margin-block-start: var(--size-8);
			}
		}

		p {
			font-size: var(--font-size-4);
			opacity: 0.8;
			padding-block-start: var(--size-1);
		}
	}
</style>
