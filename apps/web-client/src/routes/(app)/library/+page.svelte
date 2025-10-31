<script lang="ts">
import type { LibraryItem } from "@atlas/core/library";
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import { openPath } from "$lib/utils/tauri-loader";

const appCtx = getAppContext();

let libraryItems = $state<LibraryItem[]>([]);

onMount(async () => {
  // Load library items
  const items = await appCtx.daemonClient.listLibraryItems({ limit: 50 });
  libraryItems = items.items;
});
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
				{#if __TAURI_BUILD__}
					<button
						class="row"
						onclick={async () => {
							if (!openPath || !item.full_path) return;
							try {
								await openPath(item.full_path);
							} catch (error) {
								console.error("Failed to open path:", error);
								alert("Failed to open file");
							}
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
				{:else}
					<div class="row">
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
					</div>
				{/if}
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
		font-size: var(--font-size-5);
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
			transition: all 75ms ease;

			&:last-child {
				border-block-end: none;
			}

			&:matches(button):hover {
				background-color: var(--color-surface-2);
			}
		}

		.header {
			font-weight: var(--font-weight-6);
		}

		.header,
		.cell {
			align-items: center;
			display: flex;
			font-size: var(--font-size-3);
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
