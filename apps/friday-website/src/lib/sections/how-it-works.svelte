<script lang="ts">
import avatar from "$lib/assets/avatar.webp";
import Chat from "$lib/icons/chat.svelte";

const DURATION_MS = 5000;
const ITEM_COUNT = 3;

let activeItem = $state(2);
let progress = $state(0);
let startTime = $state(Date.now());

function resetTimer(item: number) {
  if (item === activeItem) return;

  activeItem = item;
  progress = 0;
  startTime = Date.now();
}

$effect(() => {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  let rafId: number;

  function tick() {
    const elapsed = Date.now() - startTime;
    progress = Math.min((elapsed / DURATION_MS) * 100, 100);

    if (progress >= 100) {
      const nextItem = (activeItem % ITEM_COUNT) + 1;
      resetTimer(nextItem);
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return () => cancelAnimationFrame(rafId);
});
</script>

<section>
	<header>
		<h2>
			<Chat />
			How it works
		</h2>
		<h3>From idea to done in minutes</h3>
	</header>

	<div class="interactive">
		<ul class="controls">
			<li>
				<button onclick={() => resetTimer(1)} class:active={activeItem === 1}>
					<p>
						1. Describe the job

						{#if activeItem === 1}
							<progress max="100" value={progress}>{progress}%</progress>
						{/if}
					</p>

					<p>Ask Friday to run any task or something more complex that runs over time.</p>
				</button>
			</li>

			<li>
				<button onclick={() => resetTimer(2)} class:active={activeItem === 2}>
					<p>
						2. Approve the plan

						{#if activeItem === 2}
							<progress max="100" value={progress}>{progress}%</progress>
						{/if}
					</p>

					<p>
						Friday spins up specialized agents that coordinate, pull in context, and take action
						across your tools.
					</p>
				</button>
			</li>

			<li>
				<button onclick={() => resetTimer(3)} class:active={activeItem === 3}>
					<p>
						3. Turn work into results

						{#if activeItem === 3}
							<progress max="100" value={progress}>{progress}%</progress>
						{/if}
					</p>

					<p>Friday delivers concrete results that you can use as is or adjust and run again.</p>
				</button>
			</li>
		</ul>

		<div class="animations">
			<div class="animation" class:visible={activeItem === 1}>
				<div class="message">
					<p>
						Review the transcript from my meeting and draft an email with a summary and clear
						next&nbsp;steps.
					</p>

					<div class="author">
						<img src={avatar} alt="User avatar" loading="lazy" />
						<time>Shay, Monday at 8:04am</time>
					</div>
				</div>
			</div>

			<div class="animation" class:visible={activeItem === 2}>
				<div class="thinking-steps">
					<ul>
						<li>Analyzing transcript</li>
						<li>Determining next steps</li>
						<li>Creating summary</li>
						<li>Sending email</li>
					</ul>

					<time>Completed in 3 minutes, 24 seconds</time>
				</div>
			</div>

			<div class="animation" class:visible={activeItem === 3}>
				<div class="result">
					<header>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							aria-hidden="true"
						>
							<path
								d="M11.5 2.5C13.433 2.5 15 4.067 15 6V10C15 11.933 13.433 13.5 11.5 13.5H4.5C2.567 13.5 1 11.933 1 10V6C1 4.067 2.567 2.5 4.5 2.5H11.5ZM2.25293 4.90723C2.09198 5.23756 2 5.60783 2 6V10C2 11.3807 3.11929 12.5 4.5 12.5H11.5C12.8807 12.5 14 11.3807 14 10V6C14 5.63579 13.9203 5.2906 13.7803 4.97852L9.11328 9.64648C8.52749 10.232 7.5779 10.2321 6.99219 9.64648L2.25293 4.90723ZM4.5 3.5C3.87581 3.5 3.30624 3.73015 2.86816 4.1084L7.69922 8.93945C7.89441 9.13459 8.21099 9.13448 8.40625 8.93945L13.1865 4.1582C12.7417 3.75068 12.1508 3.5 11.5 3.5H4.5Z"
								fill="#FF8333"
								style="fill:#FF8333;fill:color(display-p3 1.0000 0.5137 0.2000);fill-opacity:1;"
							/>
						</svg>
						<span>Meeting Summary - Project Chimera</span>
					</header>

					<hr />

					<p>
						<strong>Key discussion points:</strong> The meeting covered a review of the latest market
						analysis, an overview of competitor strategies, and a discussion on budget allocation for
						the upcoming quarter.
					</p>

					<p>
						<strong>Next steps:</strong><br />
						- Finalize campaign drafts<br />
						- Schedule client presentation<br />
						- Confirm launch date
					</p>
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		justify-content: center;
		max-inline-size: var(--size-224);
		padding-block: var(--size-16) 0;
		padding-inline: var(--size-6);

		@media (min-width: 768px) {
			margin-inline: auto;
			padding-block: var(--size-24) 0;
		}
	}

	h2 {
		align-items: center;
		color: var(--color-red-1);
		display: flex;
		gap: var(--size-1);
		font-size: var(--font-size-5);
		font-weight: var(--font-weight-5);
		line-height: var(--font-lineheight-0);
	}

	h3 {
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-6);
		letter-spacing: calc(-1 * var(--font-letterspacing-1));
		line-height: var(--font-lineheight-1);
		padding-block: var(--size-4) 0;
		text-wrap-style: pretty;
	}

	.interactive {
		align-items: center;
		display: flex;
		flex-direction: column-reverse;
		margin-block: var(--size-6) 0;

		@media (min-width: 768px) {
			display: grid;
			grid-template-columns: 1fr 1fr;
			margin-block: var(--size-12) 0;
		}
	}

	.controls {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
		margin-block: var(--size-6) 0;

		@media (min-width: 768px) {
			display: flex;
			flex-direction: column;
			gap: var(--size-9);
			margin: 0;
		}

		li {
			grid-column: 1 / -1;
			grid-row: 1 / -1;
		}

		button {
			display: grid;
			grid-template-rows: auto 1fr;
			opacity: 0;
			place-content: start;
			transition: all 200ms ease;
			text-align: left;
			visibility: hidden;

			@media (min-width: 768px) {
				grid-template-rows: auto 0fr;
				opacity: 1;
				visibility: visible;
			}

			&.active {
				grid-template-rows: auto 1fr;
				opacity: 1;
				visibility: visible;
			}

			progress {
				border-radius: var(--radius-round);
				inline-size: var(--size-6);
				block-size: var(--size-0-75);
			}

			progress::-webkit-progress-bar {
				border-radius: var(--radius-round);
				background-color: rgb(0 0 0 / 0.1);
			}

			progress::-webkit-progress-value {
				border-radius: var(--radius-round);
				background-color: var(--color-blue-2);
			}

			progress::-moz-progress-bar {
				border-radius: var(--radius-round);
				background-color: rgb(0 0 0 / 0.1);
			}

			p:nth-child(1) {
				align-items: center;
				display: flex;
				gap: var(--size-2);
				font-size: var(--font-size-6);
				font-weight: var(--font-weight-6);
				line-height: var(--font-lineheight-1);
			}

			p:nth-child(2) {
				block-size: 100%;
				font-size: var(--font-size-5);
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-3);
				max-inline-size: var(--size-96);
				opacity: 0.6;
				overflow: hidden;
				padding-block: var(--size-2) 0;
				text-wrap-style: pretty;
			}
		}
	}

	.animations {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
		max-inline-size: var(--size-112);
	}

	.animation {
		align-items: center;
		display: flex;
		grid-column: 1 / -1;
		grid-row: 1 / -1;
		justify-content: center;
		transition: all 500ms ease;
		visibility: hidden;

		&.visible {
			visibility: visible;
		}
	}

	.message {
		p {
			background-color: var(--color-canvas-light);
			border-radius: var(--radius-5);
			box-shadow: var(--shadow-1);
			color: color-mix(in srgb, var(--color-text), transparent 20%);
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-3);
			opacity: 0;
			padding-block: var(--size-3);
			padding-inline: var(--size-4);
			transform: scale(0.8);
			transition: all 300ms ease;
		}

		.author {
			align-items: center;
			display: flex;
			gap: var(--size-2);
			opacity: 0;
			padding-block: var(--size-3);
			padding-inline: var(--size-4);
			transition: all 300ms ease;
			transform: translateY(var(--size-2));

			img {
				aspect-ratio: 1;
				block-size: var(--size-5);
			}

			time {
				font-size: var(--font-size-3);
				opacity: 0.5;
			}
		}

		.visible & p {
			opacity: 1;
			transform: scale(1);
		}

		.visible & .author {
			opacity: 1;
			transition-delay: 100ms;
			transform: translateY(0);
		}
	}

	.thinking-steps {
		ul {
			display: flex;
			flex-direction: column;
			gap: var(--size-1);
		}

		li {
			align-items: center;
			border-radius: var(--radius-5);
			block-size: var(--size-11);
			color: color-mix(in srgb, var(--color-text), transparent 20%);
			display: flex;
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-6);
			justify-content: center;
			inline-size: max-content;
			opacity: 0;
			padding-inline: var(--size-6);
			transform: translateY(var(--size-1));
			text-align: center;

			&:nth-child(1) {
				background-color: #c3e9fa;
				transition: all 300ms ease;
			}

			&:nth-child(2) {
				background-color: hsl(255 95% 71% / 0.3);
				margin-inline: var(--size-5-5) 0;
				transform: translateY(var(--size-2));
				transition: all 300ms ease;
			}

			&:nth-child(3) {
				background-color: hsl(18 95% 83% / 0.8);
				margin-inline: calc(-1 * var(--size-6)) 0;
				transform: translateY(var(--size-3));
				transition: all 400ms ease;
			}

			&:nth-child(4) {
				background-color: hsl(127 100% 35% / 1);
				color: white;
				margin-inline: var(--size-9) 0;
				transform: translateY(var(--size-4));
				transition: all 500ms ease;
			}

			@supports (color: color(display-p3 0 0 0)) {
				&:nth-child(1) {
					background-color: color(display-p3 0.7647 0.9137 0.9804);
				}

				&:nth-child(2) {
					background: color(display-p3 0.5725 0.4353 0.9843 / 0.3);
				}

				&:nth-child(3) {
					background-color: color(display-p3 0.9919 0.762 0.6635 / 0.8);
				}

				&:nth-child(4) {
					background-color: color(display-p3 0 0.7034 0.0821);
				}
			}
		}

		time {
			display: block;
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			margin-block: var(--size-4) 0;
			opacity: 0;
			transition: all 200ms ease;
			transform: translateY(var(--size-2));
		}

		.visible & li {
			opacity: 1;
			transform: scale(1) translateY(0);
		}

		.visible & time {
			opacity: 0.5;
			transition-delay: 100ms;
			transform: translateY(0);
		}
	}

	.result {
		background-color: hsl(18 95% 83% / 0.3);
		border-radius: var(--radius-5);
		opacity: 0;
		max-inline-size: var(--size-88);
		padding: var(--size-4);
		transform: scale(0.92);
		transition: all 200ms ease;

		@supports (color: color(display-p3 0 0 0)) {
			background-color: color(display-p3 0.9919 0.762 0.6635 / 0.3);
		}

		header {
			align-items: center;
			display: flex;
			gap: var(--size-2);
			margin: 0;

			svg {
				flex: none;
				inline-size: var(--size-4);
				block-size: var(--size-4);
			}

			span {
				font-size: var(--font-size-4);
				font-weight: var(--font-weight-6);
				line-height: var(--font-lineheight-1);
			}
		}

		hr {
			border: none;
			border-block-start: 1px solid hsl(18 95% 83% / 1);
			margin-block: var(--size-3);
			opacity: 0.4;

			@supports (color: color(display-p3 0 0 0)) {
				border-block-start-color: color(display-p3 0.9919 0.762 0.6635 / 1);
			}
		}

		p {
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-4-5);
			line-height: var(--font-lineheight-3);
			opacity: 0.8;
		}

		p + p {
			margin-block-start: var(--size-3);
		}

		strong {
			font-weight: var(--font-weight-6);
		}

		.visible & {
			opacity: 1;
			transform: scale(1);
		}
	}
</style>
