<script>
import Section from "$lib/components/section.svelte";
import Teams from "$lib/icons/teams.svelte";
</script>

<Section
	details={[
		{
			title: 'Draft summaries, updates, or messages for review',
			description:
				'"Research a topic using links and documents I provide, then write a one-page brief with sources."'
		},
		{
			title: 'Track follow-ups and remind you when action is needed',
			description:
				'"Review the transcript from my meeting and draft an email with a summary and clear next steps."'
		},
		{
			title: 'Run recurring jobs that stay up to date over time',
			description:
				'"Monitor the weather forecast over the next 7 days and notify me when it\'s a good window to work on my yard."'
		}
	]}
>
	{#snippet header()}
		<h2 style:color="var(--color-purple-1)">
			<Teams />
			For Teams
		</h2>

		<h3>Use Friday to coordinate work across people, tools, and shared processes.</h3>
	{/snippet}
</Section>
