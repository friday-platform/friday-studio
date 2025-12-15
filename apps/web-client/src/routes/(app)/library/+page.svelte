<script lang="ts">
import { resolve } from "$app/paths";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

function formatArtifactType(type: string): string {
  return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
</script>

<Breadcrumbs.Root>
	<Breadcrumbs.Item href="/library">Library</Breadcrumbs.Item>
</Breadcrumbs.Root>

<div class="container">
	<div class="items">
		<div class="table">
			<div class="row">
				<div class="header">Title</div>
				<div class="header">Type</div>
				<div class="header created">Created</div>
			</div>

			{#each data.artifacts as artifact (artifact.id)}
				<a class="row" href={resolve('/library/[artifactId]', { artifactId: artifact.id })}>
					<div class="cell">
						{artifact.title}
					</div>

					<div class="cell type">
						{formatArtifactType(artifact.type)}
					</div>

					<div class="cell created">
						{new Date(artifact.createdAt).toLocaleString('en-US', {
							dateStyle: 'long',
							timeStyle: 'short'
						})}
					</div>
				</a>
			{/each}

			{#if data.artifacts.length === 0}
				<div class="row empty">
					<div class="cell" style="grid-column: 1 / -1; text-align: center; color: var(--text-3);">
						No artifacts yet
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.container {
		block-size: 100%;
		display: flex;
		flex-direction: column;
		inline-size: 100%;
		padding: var(--size-8);
		padding-block: var(--size-12) 0;
		overflow: hidden;
	}

	h2 {
		flex: none;
		font-size: var(--font-size-8);
		font-weight: var(--font-weight-6);
		margin-inline: auto;
		max-inline-size: 64rem;
		inline-size: 100%;
	}

	.items {
		overflow: auto;
		scrollbar-width: thin;
	}

	.table {
		display: grid;
		grid-template-columns: 1fr max-content max-content;
		margin-block-start: var(--size-8);
		column-gap: var(--size-8);
		margin-inline: auto;
		max-inline-size: 64rem;
		inline-size: 100%;
		padding-block-end: var(--size-12);

		.row {
			align-content: center;
			block-size: var(--size-16);
			border-block-end: 1px solid var(--color-border-1);
			display: grid;
			grid-template-columns: subgrid;
			grid-column: 1 / -1;
			color: inherit;
			text-decoration: none;

			&:hover {
				background-color: var(--surface-2);
			}

			&:last-child {
				border-block-end: none;
			}

			&.empty {
				block-size: var(--size-24);
			}
		}

		.header {
			font-weight: var(--font-weight-6);
		}

		.header,
		.cell {
			align-items: center;
			display: flex;
			font-size: var(--font-size-4);
		}

		.cell {
			font-weight: var(--font-weight-5);
		}

		.created {
			justify-content: end;
			text-align: right;
		}

		.cell.created {
			color: var(--text-3);
		}
	}
</style>
