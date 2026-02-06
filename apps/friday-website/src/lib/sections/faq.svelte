<script lang="ts">
import Arrow from "$lib/icons/arrow.svelte";
import Faq from "$lib/icons/faq.svelte";

const items = [
  {
    question: "What is Friday?",
    answer:
      "Friday is an AI assistant that builds and runs automations through conversation. Instead of configuring workflows in visual builders, you describe what you want to accomplish, and Friday creates the automation for you. It monitors websites, processes data, sends notifications, analyzes documents, and connects to your tools.",
  },
  {
    question: "Do I need to know how to code?",
    answer:
      "No. You don't need to write code, craft prompts, understand APIs, or architect workflows like Zapier. Friday works through conversation: you describe what you want, and it handles the technical details including building the automation, writing agent prompts, configuring integrations, and setting up error handling. If you're technical, it can handle more advanced use cases, but it's designed to work without any technical knowledge.",
  },
  {
    question: "How long does it take to setup?",
    answer:
      "Most automations are ready in minutes. You describe what you want, Friday asks a few clarifying questions, shows you a plan, and builds it after you approve. If the automation needs credentials for external services (like Slack or Google Calendar), you'll do a one-time setup for those. After that, it runs automatically.",
  },
  {
    question: "How much does it cost?",
    answer:
      "Friday is completely free right now while we're in beta. We're focused on making sure Friday delivers real value before we introduce pricing.",
  },
];

let activeItems = $state<number[]>([]);
</script>

<section id="faq">
	<header>
		<h2>
			<Faq />
			Frequently Asked Questions
		</h2>
	</header>

	<ul>
		{#each items as { question, answer }, index}
			<li class:active={activeItems.includes(index)}>
				<button
					aria-expanded={activeItems.includes(index)}
					aria-controls="faq-answer-{index}"
					onclick={() => {
						if (activeItems.includes(index)) {
							activeItems = activeItems.filter((a) => a !== index);
						} else {
							activeItems = activeItems.concat([index]);
						}
					}}><Arrow />{question}</button
				>

				<p id="faq-answer-{index}" role="region">{answer}</p>
			</li>
		{/each}
	</ul>
</section>

<style>
	section {
		gap: var(--size-12);
		margin-inline: auto;
		max-inline-size: var(--size-224);
		padding-block: var(--size-16) var(--size-24);
		padding-inline: var(--size-6);

		@media (min-width: 768px) {
			padding-block: var(--size-24) var(--size-48);
		}
	}

	header {
		grid-column: 1 / span 2;

		h2 {
			align-items: center;
			color: var(--color-blue-2);
			display: flex;
			gap: var(--size-1);
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
		}
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: var(--size-6);
		margin-block: var(--size-6) 0;

		li {
			display: grid;
			grid-template-rows: auto 0fr;
			place-content: start;
			transition: all 200ms ease;

			&.active {
				grid-template-rows: auto 1fr;
			}
		}

		button {
			align-items: center;
			display: flex;
			gap: var(--size-2);
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-6);

			&:hover {
				:global(svg) {
					opacity: 0.6;
				}
			}
		}

		p {
			block-size: 100%;
			font-size: var(--font-size-5);
			max-inline-size: 84ch;
			opacity: 0.7;
			overflow: hidden;
			padding-inline: var(--size-6) 0;
			text-wrap-style: balance;
		}

		& :global(svg) {
			opacity: 0.2;
			transition: all 200ms ease;
		}

		.active :global(svg) {
			opacity: 0.2;
			transform: rotate(90deg);
		}
	}
</style>
