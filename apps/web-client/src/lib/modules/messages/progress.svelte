<script lang="ts">
import type { UIDataTypes, UIMessagePart, UITools } from "ai";

let time = $state(0);

const { actions }: { actions: UIMessagePart<UIDataTypes, UITools>[] } = $props();

const progressActions = $derived(actions.filter((action) => action.type === "data-tool-progress"));
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
	<div class="progress">{getMessage()} {time}s...</div>

	{#if progressActions.length > 0}
		<div class="in-progress-tools">
			<h2>Working...</h2>

			<ul>
				{#each progressActions as action}
					{#if 'data' in action}
						{#if typeof action.data === 'object' && action.data !== null && 'content' in action.data}
							<li>{action.data.content}</li>
						{/if}
					{/if}
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.container {
		display: flex;
		flex-direction: column;
		align-items: start;
		gap: var(--size-1);
	}

	.progress {
		align-items: center;
		background: var(--gradient-black-2);
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		color: var(--text-1);
		display: flex;
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		justify-content: center;
		padding-inline: var(--size-3);
	}

	/* .action {
		align-items: center;
		border: 1px solid var(--border-2);
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		color: var(--text-1);
		display: flex;
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		justify-content: center;
		padding-inline: var(--size-3);
	} */

	.in-progress-tools {
		background-color: var(--background-1);
		border: var(--size-px) solid var(--border-2);
		border-radius: var(--radius-4);
		padding: var(--size-4);

		h2 {
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-6);
		}

		ul {
			list-style-type: '⋅ ';
		}

		li {
			color: var(--text-3);
			margin-inline-start: var(--size-3);
			font-size: var(--font-size-5);
		}
	}
</style>
