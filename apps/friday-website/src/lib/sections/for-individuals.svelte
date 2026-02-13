<script>
import Section from "$lib/components/section.svelte";
import Individuals from "$lib/icons/individuals.svelte";
</script>

<Section
	details={[
		{
			title: 'Run always-on tasks that work while you’re away.'
		},
		{
			title: 'Turn scattered inputs into clear, usable briefs.'
		},
		{
			title: 'Set recurring jobs that monitor what matters and keep you up to date.'
		}
	]}
>
	{#snippet header()}
		<h2 style:color="var(--color-green-1)">
			<Individuals />
			For Individuals
		</h2>

		<h3>Your personal AI concierge</h3>
	{/snippet}
</Section>
