<script lang="ts">
import { createTable, getCoreRowModel } from "@tanstack/svelte-table";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { Table } from "$lib/components/table";
import { artifactColumns } from "$lib/modules/library/columns";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

const table = createTable({
  get data() {
    return data.artifacts;
  },
  columns: artifactColumns,
  getCoreRowModel: getCoreRowModel(),
  getRowId: (row) => row.id,
});
</script>

<Breadcrumbs.Root>
	<Breadcrumbs.Item href="/library">Library</Breadcrumbs.Item>
</Breadcrumbs.Root>

<div class="page">
	<div class="content">
		{#if data.artifacts.length === 0}
			<p class="empty">No artifacts yet</p>
		{:else}
			<Table.Root {table} rowSize="large" rowPath={(item) => `/library/${item.id}`} hideHeader />
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		block-size: 100%;
		inline-size: 100%;
	}

	.content {
		flex: 1;
		padding-block: var(--size-12);
		padding-inline: var(--size-14);
	}

	.empty {
		color: var(--text-3);
		font-size: var(--font-size-3);
	}
</style>
