<script lang="ts">
import { resolve } from "$app/paths";
import circleDecal from "$lib/assets/circle-decal.svg";
import Announcement from "$lib/components/announcement.svelte";
import BackgroundBlobs from "$lib/components/background-blobs.svelte";
import Faq from "$lib/sections/faq.svelte";
import ForIndividuals from "$lib/sections/for-individuals.svelte";
import ForTeams from "$lib/sections/for-teams.svelte";
import HowItWorks from "$lib/sections/how-it-works.svelte";
import UseCases from "$lib/sections/use-cases.svelte";
</script>

<svelte:head>
	<title>Friday — The AI that works while you're away</title>
	<meta
		name="description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Friday — The AI that works while you're away" />
	<meta
		property="og:description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
	<meta name="twitter:title" content="Friday — The AI that works while you're away" />
	<meta
		name="twitter:description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
</svelte:head>

<div class="background">
	<BackgroundBlobs />
</div>

<Announcement text="Introducing Friday" href={resolve('/announcement')} />

<UseCases />

<div class="separator">
	<img src={circleDecal} alt="" aria-hidden="true" />
</div>

<HowItWorks />
<ForIndividuals />
<ForTeams />
<Faq />

<style>
	.background {
		block-size: 409px;
		aspect-ratio: 1 / 1;
		inset-inline-end: 0;
		overflow-x: clip;
		inset-block-start: 0;
		position: absolute;
		pointer-events: none;
		z-index: -1;

		@media (min-width: 768px) {
			block-size: 818px;
		}
	}

	.separator {
		align-items: center;
		background-color: color-mix(in srgb, var(--color-text), transparent 90%);
		block-size: var(--size-px);
		display: flex;
		margin-inline: auto;
		inline-size: var(--size-56);
		position: relative;
		z-index: -2;

		img {
			background-color: var(--color-canvas);
			inline-size: var(--size-24);
			padding-inline: var(--size-3);
			margin-inline: auto;
		}
	}
</style>
