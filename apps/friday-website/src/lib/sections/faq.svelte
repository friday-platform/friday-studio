<script lang="ts">
import Arrow from "$lib/icons/arrow.svelte";
import Faq from "$lib/icons/faq.svelte";

const items = [
  {
    question: "What is Friday?",
    answer:
      "Friday is an AI-powered assistant that lets you get real work done across your tools. Describe what you want to accomplish, and Friday delivers the automation for you. It monitors websites, processes data, sends notifications, analyzes documents, and more.",
  },
  {
    question: "Do I need to know how to code?",
    answer:
      "No, Friday works through conversation: you describe what you want, and it handles the details. If you are technical and prefer to write code, you can also work with configuration files in yaml.",
  },
  {
    question: "How long does it take to setup?",
    answer:
      "Automations are ready in minutes. Either choose from a preexisting template, or describe what you want in conversation, and Friday will build the workspace for your use case. ",
  },
  {
    question: "How do I get started?",
    answer:
      "Just try a prompt in chat, or choose one from an existing template. Friday will ask you a few questions and connect the relevant apps to get you started.",
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
		{#each items as { question, answer }, index (index)}
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

				<p id="faq-answer-{index}" role="region" aria-hidden={!activeItems.includes(index)}>
					{answer}
				</p>
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
