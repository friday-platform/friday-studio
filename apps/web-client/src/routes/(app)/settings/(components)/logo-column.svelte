<script lang="ts">
import { Icons } from "$lib/components/icons";
import Atlassian from "$lib/components/icons/integrations/atlassian.svelte";
import Linear from "$lib/components/icons/integrations/linear.svelte";
import Notion from "$lib/components/icons/integrations/notion.svelte";
import SlackColor from "$lib/components/icons/integrations/slack-color.svelte";

type Props = { provider: string };

let { provider }: Props = $props();
</script>

{#if provider === 'slack'}
	<div class="icon" style:--background="#EEE9EF" style:--background-dark="#3C173E">
		<SlackColor />
	</div>
{:else if provider === 'notion'}
	<div class="icon" style:--background="#E7E7E8" style:--background-dark="#2E2F33">
		<Notion />
	</div>
{:else if provider === 'linear'}
	<div class="icon" style:--background="#EDEFFA" style:--background-dark="#222538">
		<Linear />
	</div>
{:else if provider === 'atlassian'}
	<div class="icon" style:--background="#E8F1FF" style:--background-dark="#1A2436">
		<Atlassian />
	</div>
{:else}
	<div
		class="icon"
		style:--background="var(--color-highlight-1)"
		style:--background-dark="var(--color-highlight-1)"
	>
		<Icons.Key />
	</div>
{/if}

<style>
	.icon {
		align-items: center;
		background-color: var(--background);
		border-radius: var(--radius-3);
		block-size: var(--size-9);
		display: flex;
		justify-content: center;
		inline-size: var(--size-9);
		color: var(--color-text);

		@media (prefers-color-scheme: dark) {
			background-color: var(--background-dark);
		}
	}
</style>
