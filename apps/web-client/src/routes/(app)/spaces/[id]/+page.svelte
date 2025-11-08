<script lang="ts">
import type { PageData } from "./$types";
import Breadcrumbs from "./(components)/breadcrumbs.svelte";

let { data }: { data: PageData } = $props();

const workspace = $derived(data.workspace);

const pluralRules = new Intl.PluralRules("en-US");
function pluralize(count: number, singular: string, plural: string) {
  return pluralRules.select(count) === "one" ? singular : plural;
}
</script>

<Breadcrumbs />

<div class="page">
	<div class="content">
		<h1>{workspace.name}</h1>

		<div class="metadata">
			{#if workspace.config?.jobs}
				{@const count = Object.keys(workspace.config.jobs).length}
				<div class="metadata-item">
					<span>{count} {pluralize(count, 'Job', 'Jobs')}</span>
				</div>
			{/if}
			{#if workspace.config?.agents}
				{@const count = Object.keys(workspace.config.agents).length}
				<div class="metadata-item">
					<span>{count} {pluralize(count, 'Agent', 'Agents')}</span>
				</div>
			{/if}
			{#if workspace.config?.signals}
				{@const count = Object.keys(workspace.config.signals).length}
				<div class="metadata-item">
					<span>{count} {pluralize(count, 'Signal', 'Signals')}</span>
				</div>
			{/if}
		</div>
	</div>

	<aside class="sidebar">
		{#if workspace.config?.jobs}
			<div class="sidebar-section">
				<h2 class="sidebar-label">Jobs</h2>
				<ul class="sidebar-list">
					{#each Object.keys(workspace.config.jobs) as jobId}
						<li class="sidebar-item">{workspace.config.jobs[jobId].name || jobId}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if workspace.config?.agents}
			<div class="sidebar-section">
				<h2 class="sidebar-label">Agents</h2>
				<ul class="sidebar-list">
					{#each Object.keys(workspace.config.agents) as agentId}
						<li class="sidebar-item">{agentId}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if workspace.config?.signals}
			<div class="sidebar-section">
				<h2 class="sidebar-label">Signals</h2>
				<ul class="sidebar-list">
					{#each Object.keys(workspace.config.signals) as signalId}
						<li class="sidebar-item">
							{workspace.config.signals[signalId].description || signalId}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</aside>
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

	h1 {
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-7);
		margin-bottom: var(--size-4);
	}

	.metadata {
		display: flex;
		align-items: center;
		gap: var(--size-4);
		margin-bottom: var(--size-7);
	}

	.metadata-item {
		display: flex;
		align-items: center;
		gap: var(--size-1);
	}

	.metadata-item span {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5-5);
		color: var(--text-1);
		opacity: 0.7;
		line-height: 1.4;
	}

	.sidebar {
		inline-size: 228px;
		padding-block: var(--size-6);
		padding-inline: var(--size-6) 0;
		display: flex;
		flex-direction: column;
		gap: var(--size-7);
	}

	.sidebar-section {
		display: flex;
		flex-direction: column;
		gap: var(--size-2);
	}

	.sidebar-label {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		color: var(--text-1);
		opacity: 0.5;
		margin: 0;
	}

	.sidebar-list {
		display: flex;
		flex-direction: column;
		gap: var(--size-2);
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.sidebar-item {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		color: var(--text-1);
		line-height: 1.25;
	}
</style>
