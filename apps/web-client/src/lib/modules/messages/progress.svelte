<script lang="ts">
import type { UIDataTypes, UIMessagePart, UITools } from "ai";
import { CustomIcons } from "src/lib/components/icons/custom";

let time = $state(0);

const { actions }: { actions: UIMessagePart<UIDataTypes, UITools>[] } = $props();

const progressActions = $derived.by(() => {
  const lastIndex = actions.map((a) => a.type).lastIndexOf("data-tool-progress");
  return lastIndex !== -1 ? actions.slice(lastIndex, lastIndex + 1) : [];
});

const staticActions = $derived(actions.filter((action) => action.type !== "data-tool-progress"));

$effect(() => {
  let interval: ReturnType<typeof setInterval> | null = null;

  interval = setInterval(() => {
    time += 1;
  }, 1000);

  return () => {
    if (interval) {
      clearInterval(interval);
    }
  };
});

function getMessage() {
  const lastItem = staticActions.at(-1);

  if (lastItem?.type === "text") {
    return "Typing";
  } else if (lastItem?.type === "step-start") {
    return "Processing";
  } else if (lastItem?.type.startsWith("tool-")) {
    return "Calling Tools";
  } else {
    return "Thinking";
  }
}
</script>

<div class="container">
	{#if progressActions.length > 0}
		{#each progressActions as action}
			{#if 'data' in action}
				{#if typeof action.data === 'object' && action.data !== null && 'content' in action.data && 'toolName' in action.data}
					<div class="in-progress-tools">
						{#if action.data.toolName === 'Research Agent'}
							<CustomIcons.Globe />
						{:else if action.data.toolName === 'Slack'}
							<CustomIcons.Slack />
						{:else if action.data.toolName === 'Workspace Creator'}
							<CustomIcons.Workspace />
						{:else}
							<CustomIcons.Workspace />
						{/if}

						<div class="details">
							{#if action.data.toolName === 'Research Agent'}
								<h2>Searching the web</h2>
							{:else if action.data.toolName === 'Slack'}
								<h2>Sending message to Slack</h2>
							{:else if action.data.toolName === 'Workspace Creator'}
								<h2>Creating Workspace</h2>
							{:else}
								<h2>Working...</h2>
							{/if}
							<span>{action.data.content}</span>
						</div>
					</div>
				{/if}
			{/if}
		{/each}
	{:else}
		<div class="progress">{getMessage()} {time}s...</div>
	{/if}
</div>

<style>
	.container {
		display: flex;
		flex-direction: column;
		align-items: start;
		gap: var(--size-1);
		margin-block-start: var(--size-2);
	}

	.progress {
		align-items: center;
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		display: flex;
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		justify-content: center;
	}

	.in-progress-tools {
		background-color: var(--color-surface-1);
		border: var(--size-px) solid var(--border-2);
		border-radius: var(--radius-4);
		padding: var(--size-3);
		padding-inline-end: var(--size-3-5);
		display: flex;
		align-items: center;
		gap: var(--size-3);
		max-inline-size: var(--size-88);
		inline-size: max-content;

		& :global(svg) {
			flex: none;
		}

		.details {
			display: flex;
			flex-direction: column;
			inline-size: 100%;
			overflow: hidden;

			h2 {
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-5);
				line-height: var(--font-lineheight-1);
			}

			span {
				color: var(--text-3);
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				max-inline-size: 100%;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
		}
	}
</style>
