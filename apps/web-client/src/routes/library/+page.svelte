<script lang="ts">
import { openPath } from "@tauri-apps/plugin-opener";
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";

import type { LibraryItem } from "../../../../../src/core/library/types.ts";

const { daemonClient } = getAppContext();

let libraryItems = $state<LibraryItem[]>([]);

onMount(async () => {
  const items = await daemonClient.listLibraryItems({ limit: 50 });

  libraryItems = items.items;
});

function getAtlasDaemonUrl() {
  return "http://localhost:8080";
}
</script>

<div class="container">
	<h2>Library</h2>

	<div class="items">
		<div class="table">
			<div class="row">
				<div class="header">Name</div>
				<div class="header">MIME Type</div>
				<div class="header created">Created</div>
			</div>

			{#each libraryItems as item}
				<button
					class="row"
					onclick={async () => {
						await openPath(item.full_path);
					}}
				>
					<div class="cell">
						{item.name}
					</div>

					<div class="cell">
						{item.mime_type || 'unknown'}
					</div>

					<div class="cell created">
						{new Date(item.created_at).toLocaleString('en-US', {
							dateStyle: 'long',
							timeStyle: 'short'
						})}
					</div>
				</button>
			{/each}
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
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-7);
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
			border-block-end: 1px solid var(--border-1);
			display: grid;
			grid-template-columns: subgrid;
			grid-column: 1 / -1;
			transition: all 75ms ease;

			&:last-child {
				border-block-end: none;
			}

			&:matches(button):hover {
				background-color: var(--highlight-1);
			}
		}

		.header {
			font-weight: var(--font-weight-6);
		}

		.header,
		.cell {
			align-items: center;
			display: flex;
			font-size: var(--font-size-5);
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
