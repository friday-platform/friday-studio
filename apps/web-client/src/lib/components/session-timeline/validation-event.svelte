<script lang="ts">
import type { SessionHistoryEvent } from "@atlas/core/session/history-storage";

interface Props {
  event: SessionHistoryEvent;
}

let { event }: Props = $props();

const data = $derived("score" in event.data ? event.data : null);

let analysisExpanded = $state(false);

const analysisContent = $derived.by(() => {
  if (!data || !data.analysis) {
    return null;
  }

  const formatted = JSON.stringify(data.analysis, null, 2);
  const TRUNCATE_LENGTH = 300;

  return {
    full: formatted,
    truncated: formatted.slice(0, TRUNCATE_LENGTH) + "\n...",
    shouldTruncate: formatted.length > TRUNCATE_LENGTH,
  };
});
</script>

{#if data}
	<div
		class="validation-event"
		class:pass={data.verdict === 'pass'}
		class:fail={data.verdict === 'fail'}
		class:retry={data.verdict === 'retry'}
	>
		<div class="validation-header">
			<span class="validation-label">Validation</span>
			<span class="validation-verdict">{data.verdict}</span>
			<span class="validation-score">Score: {data.score.toFixed(2)}</span>
		</div>

		{#if analysisContent}
			<button class="analysis-toggle" onclick={() => (analysisExpanded = !analysisExpanded)}>
				{analysisExpanded ? 'Hide analysis' : 'Show analysis'}
			</button>
			{#if analysisExpanded}
				<pre class="validation-analysis">{analysisContent.full}</pre>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.validation-event {
		border: 1px solid var(--border-1);
		border-radius: var(--radius-2);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
	}

	.validation-event.pass {
		background-color: var(--background-2);
		border-color: var(--color-green-3);
	}

	.validation-event.fail {
		background-color: var(--background-2);
		border-color: var(--color-red-3);
	}

	.validation-event.retry {
		background-color: var(--background-2);
		border-color: var(--color-yellow-3);
	}

	.validation-header {
		align-items: center;
		display: flex;
		gap: var(--size-2);
	}

	.validation-label {
		color: var(--text-3);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.validation-verdict {
		color: var(--text-1);
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-6);
		text-transform: uppercase;
	}

	.validation-event.pass .validation-verdict {
		color: var(--color-green-3);
	}

	.validation-event.fail .validation-verdict {
		color: var(--color-red-3);
	}

	.validation-event.retry .validation-verdict {
		color: var(--color-yellow-3);
	}

	.validation-score {
		color: var(--text-3);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
	}

	.analysis-toggle {
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

	.analysis-toggle:hover {
		background-color: var(--background-3);
		border-color: var(--border-2);
	}

	.validation-analysis {
		background-color: var(--background-3);
		border-radius: var(--radius-1);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
		line-height: var(--font-lineheight-3);
		margin-block-start: var(--size-2);
		overflow-x: auto;
		padding-block: var(--size-2);
		padding-inline: var(--size-2);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
