<script lang="ts">
import type { WorkspacePlan } from "@atlas/core/artifacts";

type Props = { workspacePlan: WorkspacePlan };
let { workspacePlan }: Props = $props();

let isExpanded = $state(false);
</script>

<div class="wrapper">
	<div class="component">
		<header>
			<span>Plan</span>

			<button onclick={() => (isExpanded = !isExpanded)}
				>{isExpanded ? 'Collapse' : 'Expand'}</button
			>
		</header>

		<div class="summary" class:expanded={isExpanded}>
			<h1>{workspacePlan.workspace.name}</h1>
			<p>{workspacePlan.workspace.purpose}</p>

			{#each workspacePlan.jobs as job}
				{@const signal = workspacePlan.signals.find((s) => s.id === job.triggerSignalId)}

				<h2>{job.name}</h2>
				<p>{signal?.description}</p>

				<ul>
					{#each job.steps as step}
						{@const agent = workspacePlan.agents.find((a) => a.id === step.agentId)}
						<li>
							<strong>{agent?.name}</strong>

							<p>{agent?.description}</p>
						</li>
					{/each}
				</ul>
			{/each}
		</div>
	</div>
</div>

<style>
	.wrapper {
		inline-size: var(--size-160);
		margin-inline: auto;
		padding-inline: var(--size-8);
	}

	.component {
		border: var(--size-px) solid color-mix(in oklch, var(--color-border-1), transparent 50%);
		border-radius: var(--radius-4);
		flex: none;
		overflow: hidden;
		position: relative;

		header {
			align-items: center;
			display: flex;
			font-size: var(--font-size-2);
			justify-content: space-between;
			padding-block-start: var(--size-5);
			padding-inline: var(--size-5);
			position: relative;
			z-index: var(--layer-2);

			span {
				font-weight: var(--font-weight-4-5);
				opacity: 0.5;
			}

			button {
				opacity: 0.8;

				&:hover {
					text-decoration: underline;
				}
			}
		}
	}

	.summary {
		& {
			max-block-size: var(--size-24);
			overflow: hidden;
			padding-inline: var(--size-5);
			padding-block: var(--size-2) var(--size-5);
		}

		&:after {
			background: linear-gradient(
				to top,
				var(--color-surface-1) 0%,
				color-mix(in oklch, var(--color-surface-1), transparent 100%)
			);
			content: '';
			position: absolute;
			inset-inline: 0;
			inset-block-end: 0;
			block-size: var(--size-20);
			inline-size: 100%;
			z-index: var(--layer-1);
		}

		&.expanded {
			max-block-size: none;
			overflow: visible;

			&:after {
				display: none;
			}
		}

		& :global(h1) {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
			margin-block-end: var(--size-1-5);
		}

		& :global(h2) {
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
			margin-block: var(--size-3) var(--size-0-5);
		}

		& :global(ul:not(:last-child)) {
			margin-block-end: var(--size-2);
		}

		& :global(li) {
			margin-block-start: var(--size-2);
		}

		& :global(p) {
			opacity: 0.7;
		}

		& :global(p),
		& :global(li) {
			color: var(--text-1);

			font-size: var(--font-size-3);
			line-height: var(--font-lineheight-3);
		}

		& :global(strong) {
			font-weight: var(--font-weight-5);
		}
	}
</style>
