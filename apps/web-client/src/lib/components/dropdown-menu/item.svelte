<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";

import { getContext } from "./context";

const { item } = getContext();

type Props = {
  children: Snippet;
  accent?: "primary" | "destructive" | "information" | "inherit" | "none";
  href?: string;
  description?: Snippet;
  indeterminate?: boolean;
  closeOnClick?: boolean;
  noninteractive?: boolean;
  disabled?: boolean;
  size?: "default" | "large";
  faded?: boolean;
};

let {
  children,
  accent = "none",
  description,
  indeterminate = false,
  closeOnClick = true,
  noninteractive = false,
  size = "default",
  faded = false,
  // important: disabled should not have a default value, as any value is considered true
  disabled,
  ...rest
}: Props & HTMLAttributes<HTMLElement> = $props();

function getElementType() {
  if (rest?.href) {
    return "a";
  } else if (noninteractive) {
    return "div";
  } else {
    return "button";
  }
}
</script>

{#snippet contents()}
	<span class="label">
		{@render children()}
	</span>

	{#if description}
		<div class="item-description">
			{@render description()}
		</div>
	{/if}
{/snippet}

<!-- svelte-ignore event_directive_deprecated -->
<svelte:element
	this={getElementType()}
	{disabled}
	use:item
	{...$item}
	{...rest}
	class:description={description !== undefined}
	class="item accent--{accent} size--{size}"
	class:faded
	on:m-click={(e) => {
		if (!closeOnClick) {
			e.preventDefault();
		}
	}}
>
	{@render contents()}
</svelte:element>

<style>
	.item {
		block-size: var(--size-8);
		cursor: default;
		display: flex;
		flex: 1 0 auto;
		flex-direction: column;
		gap: var(--size-1);
		justify-content: center;
		padding-inline: var(--size-3);
		position: relative;
		text-align: left;
		transition: color 150ms ease;
		white-space: nowrap;
		outline: none;
		z-index: 0;

		&.size--large {
			block-size: var(--size-10);
		}

		&.description {
			block-size: auto;
			min-block-size: var(--size-9);
			padding-block: var(--size-2);
			text-wrap: balance;
			white-space: normal;
		}

		.item-description {
			opacity: 0.5;
			font-size: var(--font-size-2);
			line-height: var(--font-lineheight-2);
		}

		&.faded,
		&[data-disabled] {
			opacity: 0.5;
		}

		&:before {
			background-color: var(--color-surface-2);
			border-radius: var(--radius-2-5);
			content: '';
			position: absolute;
			opacity: 0;
			inset-block: 0;
			inset-inline: var(--size-1);
			z-index: -1;
		}

		&:hover:not([data-disabled]):before,
		&[data-highlighted]:not([data-disabled]):before {
			opacity: 1;
		}
	}

	.label {
		align-items: center;
		display: flex;
		gap: var(--size-1-5);
		inline-size: 100%;
		font-weight: var(--font-weight-5);
		line-height: var(--font-lineheight-0);

		.faded & :global(svg) {
			opacity: 0.5;
		}
	}

	.accent--inherit :global(svg) {
		color: currentColor;
	}

	.accent--none :global(svg) {
		color: var(--color-text);
	}

	.accent--primary :global(svg) {
		color: var(--accent-1);
	}

	.accent--destructive :global(svg) {
		color: var(--color-red);
	}
</style>
