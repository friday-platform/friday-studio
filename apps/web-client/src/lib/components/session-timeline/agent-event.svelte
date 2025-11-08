<script lang="ts">
import type { SessionHistoryEvent } from "@atlas/core/session/history-storage";

interface Props {
  event: SessionHistoryEvent;
}

let { event }: Props = $props();

const isStart = $derived(event.type === "agent-start");
const isOutput = $derived(event.type === "agent-output");
const isError = $derived(event.type === "agent-error");

const TRUNCATE_LENGTH = 1000;

let outputExpanded = $state(false);
let structuredExpanded = $state(false);

const outputContent = $derived.by(() => {
  if (!isOutput || !("snapshot" in event.data) || !event.data.snapshot) {
    return null;
  }

  const snapshot = event.data.snapshot;

  if (snapshot.outputText) {
    const text = snapshot.outputText;
    return {
      type: "text" as const,
      full: text,
      truncated: text.slice(0, TRUNCATE_LENGTH) + "...",
      shouldTruncate: text.length > TRUNCATE_LENGTH,
    };
  }

  if (snapshot.structuredOutput) {
    const formatted = JSON.stringify(snapshot.structuredOutput, null, 2);
    return {
      type: "structured" as const,
      full: formatted,
      truncated: formatted.slice(0, TRUNCATE_LENGTH) + "\n...",
      shouldTruncate: formatted.length > TRUNCATE_LENGTH,
    };
  }

  return null;
});

const inputSummary = $derived.by(() => {
  if (!isStart || !("input" in event.data)) {
    return null;
  }

  const input = event.data.input;
  if (typeof input === "string" && input.length > 100) {
    return input.slice(0, 100) + "...";
  }
  if (typeof input === "string") {
    return input;
  }
  return null;
});
</script>

<div class="agent-event" class:error={isError} class:start={isStart} class:output={isOutput}>
	<div class="event-label">
		{#if isStart}
			Agent started
		{:else if isOutput}
			Output
		{:else if isError}
			Error
		{/if}
	</div>

	<div class="event-content">
		{#if isStart}
			{#if 'promptSummary' in event.data && event.data.promptSummary}
				<div class="prompt-summary">{event.data.promptSummary}</div>
			{/if}
			{#if inputSummary}
				<div class="input-summary">
					<span class="input-label">Input:</span>
					{inputSummary}
				</div>
			{/if}
		{:else if isOutput}
			{#if outputContent}
				{#if outputContent.type === 'text'}
					<div class="output-text">
						{outputExpanded || !outputContent.shouldTruncate
							? outputContent.full
							: outputContent.truncated}
					</div>
					{#if outputContent.shouldTruncate}
						<button class="expand-button" onclick={() => (outputExpanded = !outputExpanded)}>
							{outputExpanded ? 'Show less' : 'Show more'}
						</button>
					{/if}
				{:else}
					<pre class="structured-output">{structuredExpanded || !outputContent.shouldTruncate
							? outputContent.full
							: outputContent.truncated}</pre>
					{#if outputContent.shouldTruncate}
						<button
							class="expand-button"
							onclick={() => (structuredExpanded = !structuredExpanded)}
						>
							{structuredExpanded ? 'Show less' : 'Show more'}
						</button>
					{/if}
				{/if}
			{:else}
				<div class="no-output">No output available</div>
			{/if}
		{:else if isError && 'error' in event.data && event.data.error}
			<div class="error-message">{event.data.error}</div>
			{#if 'retryable' in event.data && event.data.retryable}
				<div class="retry-info">This error is retryable</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.agent-event {
		border-inline-start: 2px solid var(--border-1);
		padding-inline-start: var(--size-3);
	}

	.agent-event.start {
		border-inline-start-color: var(--color-blue-3);
	}

	.agent-event.output {
		border-inline-start-color: var(--color-green-3);
	}

	.agent-event.error {
		border-inline-start-color: var(--color-red-3);
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

	.prompt-summary {
		color: var(--text-2);
		font-style: italic;
		margin-block-end: var(--size-1);
	}

	.input-summary {
		color: var(--text-3);
		font-size: var(--font-size-2);
	}

	.input-label {
		font-weight: var(--font-weight-6);
	}

	.output-text {
		line-height: var(--font-lineheight-3);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.structured-output {
		background-color: var(--background-3);
		border-radius: var(--radius-2);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
		line-height: var(--font-lineheight-3);
		overflow-x: auto;
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
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

	.error-message {
		color: var(--color-red-3);
		font-family: var(--font-family-monospace);
		line-height: var(--font-lineheight-3);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.retry-info {
		color: var(--text-3);
		font-size: var(--font-size-2);
		margin-block-start: var(--size-1);
	}

	.no-output {
		color: var(--text-3);
		font-style: italic;
	}
</style>
