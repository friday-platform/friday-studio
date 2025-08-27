<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

type Props = {
  children: Snippet;
  prepend?: Snippet;
  append?: Snippet;
  type?: "button" | "reset" | "submit";
  href?: string;
  noninteractive?: boolean;
};

let {
  children,
  prepend = undefined,
  append = undefined,
  type = "button",
  href = undefined,
  noninteractive = false,
  ...rest
}: Props & HTMLButtonAttributes & HTMLAnchorAttributes = $props();
</script>

{#snippet contents()}
	<span class="contents">
		{@render children()}
	</span>
{/snippet}

{#if href}
	<a {href} data-sveltekit-reload data-tempest class="button" {...rest}>
		{@render contents()}
	</a>
{:else if noninteractive}
	<div data-tempest class="button">
		{@render contents()}
	</div>
{:else}
	<button {type} {...rest} data-tempest class="button">
		{@render contents()}
	</button>
{/if}

<style>
	.button {
		--button-shadow-outline-color: rgb(238 238 239 / 0.5);

		align-items: center;
		background: var(--background-1);
		block-size: var(--size-6-5);
		border-block-start: 1px solid var(--background-1);
		background: linear-gradient(0deg, rgba(0, 52, 164, 0.05) 0%, rgba(0, 50, 159, 0.03) 100%);
		box-shadow:
			0 0 0 1px rgba(0, 1, 172, 0.15),
			0 2px 3px -1px rgba(0, 84, 212, 0.06),
			0 3px 12px -4px rgba(0, 84, 212, 0.05),
			0 4px 16px -8px rgba(0, 84, 212, 0.05),
			0 0 0 1px rgba(225, 225, 240, 0.5);
		border-radius: var(--radius-2-5);
		box-sizing: border-box;
		color: var(--text-1);
		cursor: default;
		display: inline flex;
		flex: none;
		font-family: var(--font-family-sans);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		gap: var(--size-2);
		inline-size: max-content;
		line-height: var(--font-lineheight-0);
		justify-content: center;
		padding-inline: var(--size-2);
		white-space: initial;
		transition: all 150ms ease;
		-webkit-user-select: none;
		user-select: none;

		&:focus-visible {
			outline: 1px solid var(--accent-1);
			z-index: var(--layer-1);
		}

		&[disabled=''],
		&[disabled='true'] {
			color: var(--text-3);
			pointer-events: none;
		}

		&[href] {
			cursor: pointer;

			&.cursor-default {
				cursor: default;
			}
		}

		.contents {
			position: relative;
			z-index: 1;
		}

		@media (prefers-color-scheme: dark) {
			& {
				--button-shadow-outline-color: rgba(225, 225, 239, 0);
				box-shadow:
					0px 0px 0px 1px var(--button-shadow-outline-color),
					var(--shadow-1);
			}
		}
	}
</style>
