<script lang="ts">
import Google from "$lib/assets/integrations/google.png";
import { Icons } from "$lib/components/icons";
import Atlassian from "$lib/components/icons/integrations/atlassian.svelte";
import Github from "$lib/components/icons/integrations/github.svelte";
import Linear from "$lib/components/icons/integrations/linear.svelte";
import Notion from "$lib/components/icons/integrations/notion.svelte";
import Posthog from "$lib/components/icons/integrations/posthog.svelte";
import Sentry from "$lib/components/icons/integrations/sentry.svelte";
import SlackColor from "$lib/components/icons/integrations/slack-color.svelte";

type Props = { provider: string };

const googleServices = [
  "google-calendar",
  "google-gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
];

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
{:else if provider === 'github'}
	<div class="icon" style:--background="#F0F0F0" style:--background-dark="#21262D">
		<Github />
	</div>
{:else if provider === 'sentry'}
	<div class="icon" style:--background="#EEEEF2" style:--background-dark="#242135">
		<Sentry />
	</div>
{:else if provider === 'posthog'}
	<div class="icon" style:--background="#FDF5E5" style:--background-dark="#362C1B">
		<Posthog />
	</div>
{:else if googleServices.includes(provider)}
	<div class="icon" style:--background="#EAF5FF" style:--background-dark="#1E2F40">
		<img src={Google} alt="Google Logo" />
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

		& :global(svg),
		img {
			aspect-ratio: 1 / 1;
			object-fit: contain;
			inline-size: var(--size-4);
		}

		@media (prefers-color-scheme: dark) {
			background-color: var(--background-dark);
		}
	}
</style>
