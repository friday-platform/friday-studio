<script lang="ts">
import { resolve } from "$app/paths";
import circleDecal from "$lib/assets/circle-decal.svg?no-inline";
import Announcement from "$lib/components/announcement.svelte";
import BackgroundBlobs from "$lib/components/background-blobs.svelte";
import Faq from "$lib/sections/faq.svelte";
import ForIndividuals from "$lib/sections/for-individuals.svelte";
import ForTeams from "$lib/sections/for-teams.svelte";
import HowItWorks from "$lib/sections/how-it-works.svelte";
import UseCases from "$lib/sections/use-cases.svelte";

const jsonLd =
  // biome-ignore lint/style/useTemplate: split prevents HTML parser from seeing closing script tag
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Friday",
        description:
          "Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest.",
        url: "https://hellofriday.ai",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          description: "Open beta — free to use",
        },
        publisher: { "@id": "https://hellofriday.ai/#organization" },
      },
      {
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is Friday?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Friday is an AI-powered assistant that lets you get real work done across your tools. Describe what you want to accomplish, and Friday delivers the automation for you. It monitors websites, processes data, sends notifications, analyzes documents, and more.",
            },
          },
          {
            "@type": "Question",
            name: "Do I need to know how to code?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "No, Friday works through conversation: you describe what you want, and it handles the details. If you are technical and prefer to write code, you can also work with configuration files in yaml.",
            },
          },
          {
            "@type": "Question",
            name: "How long does it take to setup?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Automations are ready in minutes. Either choose from a preexisting template, or describe what you want in conversation, and Friday will build the workspace for your use case.",
            },
          },
          {
            "@type": "Question",
            name: "How do I get started?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Just try a prompt in chat, or choose one from an existing template. Friday will ask you a few questions and connect the relevant apps to get you started.",
            },
          },
        ],
      },
    ],
  })}<` + `/script>`;
</script>

<svelte:head>
	<title>Friday — AI that works for you, around the clock</title>
	<meta
		name="description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Friday — AI that works for you, around the clock" />
	<meta
		property="og:description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
	<meta name="twitter:title" content="Friday — AI that works for you, around the clock" />
	<meta
		name="twitter:description"
		content="Friday is an AI assistant that builds and runs automations through conversation. Describe what you want, and Friday handles the rest."
	/>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- Static JSON-LD, no user input -->
	{@html jsonLd}
</svelte:head>

<div class="background">
	<BackgroundBlobs />
</div>

<Announcement
	text="Introducing Friday"
	href="https://medium.com/friday-ai/introducing-friday-f3164c655181"
	target="_blank"
	rel="noopener noreferrer"
/>

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
		aspect-ratio: 1 / 1;
		display: none;
		inset-block-start: 0;
		inset-inline-end: 0;
		overflow-x: clip;
		pointer-events: none;
		position: absolute;
		z-index: -1;

		@media (min-width: 768px) {
			block-size: 818px;
			display: block;
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
