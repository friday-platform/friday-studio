<script lang="ts">
import circleDecal from "$lib/assets/circle-decal.svg";
import BackgroundBlobs from "$lib/components/background-blobs.svelte";
import Faq from "$lib/sections/faq.svelte";
import ForIndividuals from "$lib/sections/for-individuals.svelte";
import ForTeams from "$lib/sections/for-teams.svelte";
import HowItWorks from "$lib/sections/how-it-works.svelte";
import UseCases from "$lib/sections/use-cases.svelte";
</script>

<div class="background">
	<BackgroundBlobs />
</div>

<UseCases />

<div class="separator">
	<img src={circleDecal} alt="Concentric cirlces separator" aria-hidden="true" />
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
