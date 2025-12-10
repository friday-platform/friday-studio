<script lang="ts">
import Document from "$lib/components/primitives/document.svelte";

const { data }: { data: { headers: string[]; rows: Record<string, string | number>[] } } = $props();
</script>

<Document name="Table">
	<table>
		<thead>
			<tr>
				{#each data.headers as header}
					<th>{header}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each data.rows as row}
				<tr>
					{#each data.headers as header}
						<td>{row[header]}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</Document>

<style>
	table {
		border-collapse: separate;
		border-spacing: 0;
		border-radius: var(--radius-3);
		font-size: var(--font-size-3);
		inline-size: max-content;
	}

	th,
	td {
		border: var(--size-px) solid var(--color-border-1);
		border-inline-start: none;
		border-block-start: none;
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
		min-inline-size: var(--size-32);
	}

	th:last-child,
	td:last-child {
		border-inline-end: none;
	}

	th:not(:first-child) {
		border-inline-start: none;
	}

	th {
		font-weight: var(--font-weight-5);
		text-align: left;
	}

	td {
		border-block-start: none;
	}

	tr:last-child {
		td {
			border-block-end: none;
		}
	}
</style>
