<script>
import Section from "$lib/components/section.svelte";
import Teams from "$lib/icons/teams.svelte";
</script>

<Section
	details={[
		{
			title: 'Run complex, cross-team work like analysis, research, and orchestration.'
		},
		{
			title: 'Bring company knowledge together and act on it instantly.'
		},
		{
			title: 'Make ongoing team work run itself.'
		}
	]}
>
	{#snippet header()}
		<h2 style:color="var(--color-purple-1)">
			<Teams />
			For teams
		</h2>

		<h3>Put AI to work across teams</h3>
	{/snippet}
</Section>
