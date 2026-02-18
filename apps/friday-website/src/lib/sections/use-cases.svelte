<script lang="ts">
import { onMount } from "svelte";
import pinwheel from "$lib/assets/pinwheel.svg?no-inline";
import { getServiceIcon } from "$lib/service-icons.svelte";

let promptElements: (HTMLParagraphElement | undefined)[] = $state([]);

onMount(() => {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion) {
    return;
  }

  let currentIndex = 0;
  let destroyed = false;
  let gsapModule: typeof import("gsap") | undefined;
  let splitTextModule: typeof import("gsap/SplitText") | undefined;
  const splits: Record<number, InstanceType<typeof import("gsap/SplitText").SplitText>> = {};

  function ensureSplit(index: number) {
    if (splits[index]) return splits[index];
    const el = promptElements[index];
    if (!el || !splitTextModule) return undefined;
    const split = splitTextModule.SplitText.create(el, { type: "lines", mask: "lines" });
    splits[index] = split;
    return split;
  }

  async function init() {
    [gsapModule, splitTextModule] = await Promise.all([import("gsap"), import("gsap/SplitText")]);
    if (destroyed) return;

    const { gsap } = gsapModule;
    gsap.registerPlugin(splitTextModule.SplitText);

    // Hide all prompts except the first — first prompt stays as plain
    // text (no SplitText) so it paints immediately for LCP. SplitText
    // is applied lazily when the prompt needs to animate.
    promptElements.forEach((el, i) => {
      if (!el || i === 0) return;
      gsap.set(el, { autoAlpha: 0 });
    });
  }

  function animateIn(index: number) {
    if (destroyed || !gsapModule) return;
    const { gsap } = gsapModule;
    const el = promptElements[index];
    const split = ensureSplit(index);
    if (!el || !split) return;

    gsap.set(split.lines, { y: "100%" });
    gsap.set(el, { autoAlpha: 1 });

    return gsap.to(split.lines, { duration: 0.4, y: "0%", stagger: 0.1, ease: "power2.out" });
  }

  function animateOut(index: number) {
    if (destroyed || !gsapModule) return;
    const { gsap } = gsapModule;
    const el = promptElements[index];
    const split = ensureSplit(index);
    if (!el || !split) return;

    return gsap.to(split.lines, {
      duration: 0.4,
      y: "-100%",
      stagger: 0.05,
      ease: "power2.in",
      onComplete: () => {
        if (!destroyed) gsap.set(el, { autoAlpha: 0 });
      },
    });
  }

  async function cycle() {
    if (destroyed) return;

    await animateOut(currentIndex);
    if (destroyed) return;

    currentIndex = (currentIndex + 1) % promptElements.length;

    await animateIn(currentIndex);
  }

  let rafId: number;
  let isAnimating = false;

  init()
    .then(() => {
      if (destroyed) return;
      // Pre-split first prompt now that GSAP is loaded — the DOM restructure
      // is invisible when content hasn't changed, but ensures the first
      // animateOut transition is smooth (no flash from late SplitText init)
      ensureSplit(0);
      let lastTime = performance.now();
      function tick(now: number) {
        if (destroyed) return;
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
    })
    .catch(() => {});

  return () => {
    destroyed = true;
    cancelAnimationFrame(rafId);
    const allSplits = Object.values(splits);
    if (gsapModule) {
      const { gsap } = gsapModule;
      gsap.killTweensOf(allSplits.flatMap((s) => s.lines));
    }
    for (const split of allSplits) {
      split.revert();
    }
  };
});

type UseCase = {
  title: string;
  summary: string;
  integrations: string[];
  category: "productivity" | "research" | "development" | "analysis" | "monitor";
  main?: boolean;
};

let useCases: UseCase[] = [
  {
    title: "Turn meeting notes into action",
    summary: "Meeting notes become actionable tickets with owners and priorities.",
    integrations: ["linear", "notion"],
    category: "development",
    main: true,
  },
  {
    title: "Never forget to follow up",
    summary: "Send automatic follow-ups when there’s no reply.",
    integrations: ["google-gmail", "slack"],
    category: "productivity",
  },
  {
    title: "Turn raw data into ongoing insight",
    summary: "Upload a dataset once and explore it anytime through simple questions.",
    integrations: ["google-sheets"],
    category: "analysis",
  },
  {
    title: "Walk into every meeting prepared",
    summary: "Research meeting attendees and send a briefing before you sit down.",
    integrations: ["google-gmail", "google-calendar"],
    category: "research",
    main: true,
  },
  {
    title: "Catch errors before users complain",
    summary: "Get Sentry trends summarized and delivered weekly.",
    integrations: ["sentry", "slack"],
    category: "monitor",
    main: true,
  },
  {
    title: "Stay on top of important news",
    summary: "Get a daily digest of relevant news, curated to your interests.",
    integrations: ["google-gmail"],
    category: "research",
    main: true,
  },
  {
    title: "Stop writing release notes manually",
    summary: "Auto-draft notes from PRs and publish every week.",
    integrations: ["github", "notion"],
    category: "development",
    main: true,
  },
  {
    title: "Stay ahead of your competitors",
    summary: "Get timely summaries of the competitor news that matters most.",
    integrations: ["google-gmail"],
    category: "research",
  },
  {
    title: "Make meetings count",
    summary:
      "Get meeting transcripts summarized with next steps shared out important stakeholders.",
    integrations: ["slack", "notion"],
    category: "productivity",
    main: true,
  },
  {
    title: "Stop checking your portfolio obsessively",
    summary: "Get daily stock performance updates sent straight to your inbox.",
    integrations: ["google-gmail"],
    category: "monitor",
    main: true,
  },
  {
    title: "See week-over-week performance",
    summary: "Track multiple datasets automatically and get clear trend insights.",
    integrations: ["google-sheets"],
    category: "analysis",
  },
  {
    title: "Never miss a brand mention",
    summary: "Get alerts when your brand or product appears online.",
    integrations: ["google-gmail"],
    category: "monitor",
  },
  {
    title: "Walk into standup ready",
    summary: "Generate a clear weekly update based on what you shipped.",
    integrations: ["github", "notion"],
    category: "development",
  },
  {
    title: "Never miss what matters",
    summary: "Surface urgent emails so you don’t live in your inbox.",
    integrations: ["google-gmail", "slack"],
    category: "productivity",
    main: true,
  },
  {
    title: "Turn survey responses into insights",
    summary: "Extract themes and patterns from survey responses.",
    integrations: ["google-sheets", "google-docs"],
    category: "analysis",
  },
];

let prompts = [
  "Draft release notes from the GitHub PRs merged this week and add them to my Notion page.",
  "Research the people I’m meeting with and send me a daily morning briefing.",
  "Send me a Slack summary of unread emails from the last 24 hours and highlight anything urgent.",
  "Send me a weekly email summarizing the most frequent errors and trends in Sentry.",
  "Track my stock portfolio and send me a daily email update on performance.",
  "Turn my Notion meeting notes into Jira tickets with a clear title, description, owner, and priority.",
  "Summarize my meeting transcripts, outline next steps, and post the update in Slack.",
  "Research my competitors and send me a weekday morning summary of important updates.",
];
</script>

<div class="pinwheel">
	<img src={pinwheel} alt="Pin wheel decal" aria-hidden="true" />
	<div class="pinwheel-shade"></div>
</div>
<section class="hero">
	<h1>AI that works for you, around the clock</h1>

	<div class="prompts">
		{#each prompts as item, i (item)}
			<p bind:this={promptElements[i]}>“{item}”</p>
		{/each}
	</div>

	<a
		class="cta"
		href="https://auth.hellofriday.ai/signup"
		target="_blank"
		rel="noopener noreferrer"
	>
		Start building
	</a>
</section>

<section class="use-cases" aria-label="Use cases">
	{#each useCases as item (item.title)}
		<article>
			<header>
				<span>{item.category}</span>
				<div>
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
				</div>
			</header>

			<h2>
				{item.title}
			</h2>

			<p>{item.summary}</p>
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

		h1 {
			color: var(--color-yellow-1);
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
			margin-block: calc(-1 * var(--size-4)) var(--size-4);
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
				max-inline-size: var(--size-216);
				text-wrap-style: balance;
				text-align: center;
			}

			/* First prompt visible for LCP, rest hidden until GSAP loads */
			p:not(:first-child) {
				visibility: hidden;
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
		contain: layout paint;
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
				margin-block: 0 var(--size-3);

				span {
					display: block;
					font-size: var(--font-size-2);
					font-weight: var(--font-weight-5);
					line-height: var(--font-lineheight-2);
					opacity: 0.6;
					text-transform: capitalize;

					/* span {
				margin-block: var(--size-3) var(--size-1);
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				opacity: 0.6;
			} */
				}

				div {
					display: flex;
					gap: var(--size-2);
					margin-block: var(--size-2) 0;

					& :global(svg),
					img {
						aspect-ratio: 1 / 1;
						object-fit: contain;
						inline-size: var(--size-4);
					}
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
			}
		}
	}
</style>
