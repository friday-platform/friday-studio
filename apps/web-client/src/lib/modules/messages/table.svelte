<script lang="ts">
import FlexibleContainer from "$lib/modules/messages/flexible-container.svelte";
import MessageWrapper from "./wrapper.svelte";

const { data }: { data: { headers: string[]; rows: Record<string, string | number>[] } } = $props();
</script>

<MessageWrapper>
	<div class="table-container">
		<FlexibleContainer>
			{#if data}
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
			{/if}
		</FlexibleContainer>
	</div>
</MessageWrapper>

<style>
	.table-container {
		margin-block-start: var(--size-2);
		max-inline-size: 100%;
		overflow-x: auto;
		scrollbar-width: thin;
	}

	table {
		border: var(--size-px) solid var(--color-border-1);
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
