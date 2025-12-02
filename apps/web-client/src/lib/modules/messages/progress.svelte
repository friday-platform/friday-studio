<script lang="ts">
import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
import { IconSmall } from "$lib/components/icons/small";
import FlexibleContainer from "$lib/modules/messages/flexible-container.svelte";
import { formatDuration } from "$lib/utils/date";
import MessageWrapper from "./wrapper.svelte";

const { actions, timestamp }: { actions: AtlasUIMessagePart[]; timestamp?: string } = $props();

const startTime = $derived(timestamp ? new Date(timestamp).getTime() : undefined);
let endTime = $state(Date.now());
let open = $state(false);

$effect(() => {
  let interval: ReturnType<typeof setInterval> | null = null;

  interval = setInterval(() => {
    endTime = Date.now();
  }, 1000);

  return () => {
    if (interval) {
      clearInterval(interval);
    }
  };
});

function getMessage(
  type:
    | "text"
    | "reasoning"
    | "dynamic-tool"
    | "source-url"
    | "source-document"
    | "file"
    | "step-start"
    | `tool-${string}`
    | "data-session-start"
    | "data-session-finish"
    | "data-session-cancel"
    | "data-agent-start"
    | "data-agent-finish"
    | "data-agent-error"
    | "data-agent-timeout"
    | "data-error"
    | "data-user-message"
    | "data-tool-progress",
  content?: string,
) {
  if (type === "data-session-start") {
    return "Working";
  } else if (type === "data-session-finish") {
    return "Finishing";
  } else if (type === "data-session-cancel") {
    return "Cancelling";
  } else if (type === "text") {
    return "Typing";
  } else if (type === "step-start") {
    return "Processing";
  } else if (type.startsWith("tool-")) {
    return "Calling Tools";
  } else if (type === "data-tool-progress" && content) {
    return content;
  } else {
    return "Reasoning";
  }
}
</script>

<MessageWrapper>
	<FlexibleContainer>
		<div class="container">
			<button onclick={() => (open = !open)} class:open>
				<span class="thinking">Thinking... <IconSmall.CaretRight /></span>

				{#if open}
					<footer>
						{#if startTime}
							<time>{formatDuration(startTime, endTime)}</time>
						{/if}
					</footer>

					<ul class="steps">
						{#each actions as action, index (index)}
							<li>
								{/* @ts-expect-error action is poorly typed */
								getMessage(action.type, action.data?.content)}
							</li>
						{/each}
					</ul>
				{:else}
					<footer>
						{#if startTime}
							<time>{formatDuration(startTime, endTime)}</time>
							{#if actions.length > 0}•{/if}
						{/if}

						<div class="actions">
							{#each actions as action, index (index)}
								<span class:inactive={index !== actions.length - 1}>
									{/* @ts-expect-error action is poorly typed */
									getMessage(action.type, action.data?.content)}
								</span>
							{/each}
						</div>
					</footer>
				{/if}
			</button>
		</div>
	</FlexibleContainer>
</MessageWrapper>

<style>
	.container {
		display: flex;
		flex-direction: column;
		align-items: start;
		gap: var(--size-1);
		margin-block-start: var(--size-2);
	}

	button {
		display: flex;
		flex-direction: column;
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		text-align: left;

		.thinking {
			align-items: center;
			display: flex;
			gap: var(--size-1-5);
		}

		& :global(svg) {
			transition: transform 150ms ease-in-out;
		}

		&.open :global(svg) {
			transform: rotate(90deg);
		}
	}

	footer {
		align-items: center;
		display: flex;
		gap: var(--size-1);
		font-size: var(--font-size-1);
		opacity: 0.5;
	}

	.actions {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
		inline-size: max-content;

		span {
			animation-name: fadeIn;
			animation-duration: 250ms;
			animation-timing-function: ease-in-out;
			animation-fill-mode: forwards;
			grid-column: 1 / -1;
			grid-row: 1 / -1;

			&.inactive {
				animation-name: fadeOut;
			}
		}
	}

	.steps {
		border-inline-start: var(--size-px) solid var(--color-border-1);
		margin-inline-start: var(--size-1-5);
		margin-block-start: var(--size-1);
		padding-inline-start: var(--size-3);

		li {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-4-5);
			opacity: 0.8;
		}
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(var(--size-1));
		}

		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes fadeOut {
		from {
			opacity: 1;
			transform: translateY(0);
		}

		to {
			opacity: 0;
			transform: translateY(calc(var(--size-1) * -1));
		}
	}
</style>
