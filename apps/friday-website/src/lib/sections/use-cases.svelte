<script lang="ts">
import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";
import { onMount } from "svelte";
import pinwheel from "$lib/assets/pinwheel.svg";
import { getServiceIcon } from "$lib/service-icons.svelte";

gsap.registerPlugin(SplitText);

let promptElements: HTMLParagraphElement[] = [];

onMount(() => {
  const splits: SplitText[] = [];
  let currentIndex = 0;

  // Create splits for all prompts
  promptElements.forEach((el) => {
    const split = SplitText.create(el, { type: "lines", mask: "lines" });
    splits.push(split);
    // Hide all initially except first
    gsap.set(el, { autoAlpha: 0 });
  });

  function animateIn(index: number) {
    const el = promptElements[index];
    const split = splits[index];

    // Reset lines position
    gsap.set(split.lines, { y: "100%" });
    gsap.set(el, { autoAlpha: 1 });

    return gsap.to(split.lines, { duration: 0.4, y: "0%", stagger: 0.1, ease: "power2.out" });
  }

  function animateOut(index: number) {
    const el = promptElements[index];
    const split = splits[index];

    return gsap.to(split.lines, {
      duration: 0.4,
      y: "-100%",
      stagger: 0.05,
      ease: "power2.in",
      onComplete: () => {
        gsap.set(el, { autoAlpha: 0 });
      },
    });
  }

  async function cycle() {
    // Animate out current
    await animateOut(currentIndex);

    // Move to next
    currentIndex = (currentIndex + 1) % promptElements.length;

    // Animate in next
    await animateIn(currentIndex);
  }

  // Initial animation
  animateIn(0);

  // Cycle using requestAnimationFrame
  let lastTime = performance.now();
  let rafId: number;
  let isAnimating = false;

  function tick(now: number) {
    if (!isAnimating && now - lastTime >= 5000) {
      isAnimating = true;
      cycle().then(() => {
        isAnimating = false;
        lastTime = performance.now();
      });
    }
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    splits.forEach((split) => {
      split.revert();
    });
  };
});

type UseCase = {
  title: string;
  summary: string;
  prompt: string;
  integrations: string[];
  category: "productivity" | "research" | "development" | "analysis" | "monitor";
  main?: boolean;
};

let useCases: UseCase[] = [
  {
    title: "Create Linear tickets from your meeting notes",
    summary: "Turn raw meeting notes into tickets with owners and next steps.",
    prompt:
      "From my meeting notes in Notion, create Linear tickets with a title, description, owner, and priority.",
    integrations: ["linear", "notion"],
    category: "development",
    main: true,
  },
  {
    title: "Send email reminders",
    summary: "Follow up automatically if someone has not replied after a set amount of time.",
    prompt:
      "If someone does not reply to this email in my Gmail within 3 business days, remind me on Slack and draft a polite follow-up.",
    integrations: ["google-gmail", "slack"],
    category: "productivity",
  },
  {
    title: "Upload a data set and conduct analysis via chat",
    summary: "Upload a dataset once, then explore it over time by asking questions.",
    prompt:
      "I'm going to share a dataset via Google Sheets. Remember it and answer my questions about trends, breakdowns, and specific rows as I ask them.",
    integrations: ["google-sheets"],
    category: "analysis",
  },
  {
    title: "Research brief on meeting attendees",
    summary: "Prepare briefs on the company and attendees of upcoming meetings.",
    prompt:
      "For any external meetings, research each company and attendee, then send me a briefing the morning of each meeting.",
    integrations: ["google-gmail", "google-calendar"],
    category: "research",
    main: true,
  },
  {
    title: "Error trend summary",
    summary: "Surface patterns and the most frequent errors in Sentry.",
    prompt:
      "Send me a weekly summary via Slack of the most frequent errors and any trends, including what's improved or what's gotten worse.",
    integrations: ["sentry", "slack"],
    category: "monitor",
    main: true,
  },
  {
    title: "Summarize AI related news for the day",
    summary: "Get a daily digest of relevant AI-related news, curated to your interests.",
    prompt:
      "Every weekday morning, send me a concise summary of the most important tech and AI news.",
    integrations: ["google-gmail"],
    category: "research",
    main: true,
  },
  {
    title: "Write release notes based on PRs",
    summary: "Generate clear, user-friendly release notes from merged pull requests.",
    prompt:
      "Look at all PRs merged this week and generate release notes grouped by features, improvements, and fixes. Save them to Notion.",
    integrations: ["github", "notion"],
    category: "development",
    main: true,
  },
  {
    title: "Competitor briefing",
    summary: "Get up to date on information competitor news",
    prompt:
      "Every week, send me a summary of the latest news on a short list of competitors. Make sure to link the source.",
    integrations: ["google-gmail"],
    category: "research",
  },
  {
    title: "Distribute meeting notes and next steps",
    summary: "Summarize meeting notes with action items, then share them with your team.",
    prompt:
      "Summarize meeting notes in Notion, outline next steps, and post the summary in a Slack channel.",
    integrations: ["slack", "notion"],
    category: "productivity",
    main: true,
  },
  {
    title: "Daily stock updates",
    summary: "Get a daily snapshot of your stock performance.",
    prompt:
      "Every weekday, send me a daily update on the stocks I'm tracking, including major changes and notable news.",
    integrations: ["google-gmail"],
    category: "monitor",
    main: true,
  },
  {
    title: "Week over week performance tracking",
    summary: "Track multiple data sets to understand how performance is trending.",
    prompt:
      "Compare this week's data set to last week data set and summarize the major trends and takeaways.",
    integrations: ["google-sheets"],
    category: "analysis",
  },
  {
    title: "Keyword or brand mentions",
    summary: "Get updates when your brand or product is mentioned online.",
    prompt: "Every day, monitor the web for mentions of our brand and send me a daily summary.",
    integrations: ["google-gmail"],
    category: "monitor",
  },
  {
    title: "Weekly standup summary",
    summary: "Generates a clear weekly standup update based on the work you shipped.",
    prompt:
      "Create a weekly standup summary from my GitHub commits in the last 24 hours and save to Notion.",
    integrations: ["github", "notion"],
    category: "development",
  },
  {
    title: "Email inbox summary",
    summary: "Get a daily overview of your inbox that highlight anything most pressing.",
    prompt:
      "Summarize my unread emails in the last 24 hours and send it to me in a Slack channel every morning. Call out any that seem important or urgent.",
    integrations: ["google-gmail", "slack"],
    category: "productivity",
    main: true,
  },
  {
    title: "Survey response analysis",
    summary: "Take survey responses and glean themes, patterns, and insights.",
    prompt:
      "Analyze survey responses in Google Sheets, group them by theme, and summarize the top insights and patterns in a Google Doc.",
    integrations: ["google-sheets", "google-docs"],
    category: "analysis",
  },
];

// Filter main use cases and sort by prompt length (longest first)
const mainPrompts = useCases
  .filter((uc) => uc.main)
  .sort((a, b) => b.prompt.length - a.prompt.length);
</script>

<div class="pinwheel">
	<img src={pinwheel} alt="Pin wheel decal" aria-hidden="true" />
	<div class="pinwheel-shade"></div>
</div>
<section class="hero">
	<h1>Conversation automation for everyone</h1>

	<div class="prompts">
		{#each mainPrompts as item, i (item.title)}
			<p bind:this={promptElements[i]}>“{item.prompt}”</p>
		{/each}
	</div>

	<a class="cta" href="https://auth.hellofriday.ai/signup" target="_blank">Join the Beta</a>
</section>

<section class="use-cases">
	{#each useCases as item (item.title)}
		<article>
			<header>
				{#each item.integrations as integration (integration)}
					{@const icon = getServiceIcon(integration)}
					{#if icon}
						{#if icon.type === 'component'}
							{@const Component = icon.src}
							<Component />
						{:else}
							<img src={icon.src} alt={`${integration} logo`} />
						{/if}
					{/if}
				{/each}
			</header>

			<h2>
				{item.title}
			</h2>

			<p>{item.summary}</p>

			<span>Prompt</span>

			<p class="prompt">”{item.prompt}”</p>
		</article>
	{/each}
</section>

<style>
	.pinwheel {
		inline-size: var(--size-24);
		margin-block: var(--size-12);
		margin-inline: auto;
		position: relative;
		z-index: -2;

		@media (min-width: 768px) {
			margin-block: var(--size-24) 0;
		}
	}

	.pinwheel-shade {
		background: linear-gradient(to top, var(--color-canvas) 35%, var(--color-canvas-a) 130%);
		position: absolute;
		inset: 0;
	}

	.hero {
		align-items: center;
		display: flex;
		flex-direction: column;
		justify-content: center;
		margin-inline: auto;
		padding-inline: var(--size-6);
		max-inline-size: var(--size-224);

		@media (min-width: 768px) {
		}

		h1 {
			color: var(--color-yellow-1);
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
			margin-block: calc(-1 * var(--size-6)) var(--size-3);
			position: relative;
			z-index: var(--layer-1);
		}

		.prompts {
			display: grid;
			grid-template-columns: 1fr;
			grid-template-rows: 1fr;

			p {
				font-size: var(--font-size-7);
				font-weight: var(--font-weight-6);
				grid-column: 1 / -1;
				grid-row: 1 / -1;
				letter-spacing: calc(-1 * var(--font-letterspacing-1));
				line-height: var(--font-lineheight-1);
				max-inline-size: var(--size-150);
				text-wrap-style: pretty;
				text-align: center;
			}
		}

		.cta {
			align-items: center;
			background: var(--color-canvas-light);
			block-size: var(--size-8);
			border-radius: var(--radius-4);
			box-shadow: var(--shadow-1);
			color: var(--color-blue-2);
			display: flex;
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
			justify-content: center;
			margin-block: var(--size-6) 0;
			padding-inline: var(--size-3);
			text-align: center;
			transition: all 200ms ease;

			&:hover {
				background-color: var(--color-canvas);
			}
		}
	}

	.use-cases {
		display: flex;
		gap: var(--size-6);
		max-inline-size: 100%;
		overflow-x: scroll;
		padding-block: var(--size-12) var(--size-12);
		padding-inline: var(--size-6);
		scroll-snap-type: x mandatory;
		scrollbar-width: none;
		scroll-padding: var(--size-6);

		@media (min-width: 768px) {
			padding-block: var(--size-12) var(--size-24);
			padding-inline: var(--size-24);
			scroll-padding: var(--size-24);
		}

		article {
			border-top: var(--size-px) solid hsl(0 0 100 / 0.5);
			border-radius: var(--radius-3);
			box-shadow: 0 1px 0 0 rgba(0, 0, 0, 0.08);
			display: flex;
			flex-direction: column;
			flex: none;
			inline-size: var(--size-60);
			padding: var(--size-6);
			scroll-snap-align: start;
			transition: all 200ms ease;
			text-align: left;

			&:nth-child(5n + 1) {
				background-color: var(--yellow-1);
			}

			&:nth-child(5n + 2) {
				background-color: var(--green-1);
			}

			&:nth-child(5n + 3) {
				background-color: var(--red-1);
			}

			&:nth-child(5n + 4) {
				background-color: var(--blue-1);
			}

			&:nth-child(5n) {
				background-color: var(--purple-1);
			}

			header {
				display: flex;
				gap: var(--size-2);
				margin-block: 0 var(--size-3);

				& :global(svg),
				img {
					aspect-ratio: 1 / 1;
					object-fit: contain;
					inline-size: var(--size-4);
				}
			}

			h2 {
				font-size: var(--font-size-4);
				font-weight: var(--font-weight-5);
				line-height: var(--font-lineheight-1);
				padding-block: var(--size-1);
				text-wrap-style: balance;
			}

			p {
				font-size: var(--font-size-3);
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-2);
				opacity: 0.8;

				&.prompt {
					font-size: var(--font-size-2);
				}
			}

			span {
				margin-block: var(--size-3) var(--size-1);
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				opacity: 0.6;
				text-transform: capitalize;
			}
		}
	}
</style>
