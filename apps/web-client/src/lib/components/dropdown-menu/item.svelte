<script lang="ts">
import { hasContext, type Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";
import { get } from "svelte/store";
import { KEY as DIALOG_KEY, getContext as getDialogContext } from "$lib/components/dialog/context";

import { getContext } from "./context";

const { item } = getContext();
const dialogContext = getDialogContext();

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
  fileInput?: { onchange: (files: File[]) => void; accept?: string; multiple?: boolean };
};

let {
  children,
  accent = "none",
  description,
  indeterminate: _indeterminate = false,
  closeOnClick = true,
  noninteractive = false,
  size = "default",
  faded = false,
  // important: disabled should not have a default value, as any value is considered true
  disabled,
  fileInput,
  ...rest
}: Props & HTMLAttributes<HTMLElement> = $props();

const fileInputId = $derived(fileInput ? crypto.randomUUID() : undefined);

function handleFileChange(e: Event & { currentTarget: HTMLInputElement }) {
  const files = e.currentTarget.files;
  if (files?.length) {
    fileInput?.onchange(Array.from(files));
    e.currentTarget.value = ""; // reset for re-select same file
  }
}

function getElementType() {
  if (fileInput) {
    return "label";
  } else if (rest?.href) {
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

{#if hasContext(DIALOG_KEY)}
	{@const trigger = dialogContext.trigger}
	<!-- svelte-ignore event_directive_deprecated -->
	<button
		{...rest}
		{disabled}
		use:item
		use:trigger
		{...$item}
		{...get(trigger)}
		class:description={description !== undefined}
		class="item accent--{accent} size--{size}"
		class:faded
		on:m-click={(e) => {
			e.preventDefault();
		}}
	>
		{@render contents()}
	</button>
{:else}
	{#if fileInput}
		<!-- IMPORTANT: Files cannot use mixed event handlers (onchange/on:m-click is invalid, so this has to be on:change) -->
		<!-- svelte-ignore event_directive_deprecated -->
		<input
			type="file"
			id={fileInputId}
			class="sr-only"
			accept={fileInput.accept}
			multiple={fileInput.multiple}
			on:change={handleFileChange}
		/>
	{/if}
	<!-- svelte-ignore event_directive_deprecated -->
	<svelte:element
		this={getElementType()}
		for={fileInputId}
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
{/if}

<style>
	.item {
		block-size: var(--size-8);
		cursor: default;
		display: flex;
		flex: 1 0 auto;
		flex-direction: column;
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
			block-size: var(--size-10);
		}

		.item-description {
			opacity: 0.5;
			font-size: var(--font-size-1);
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
		opacity: 0.7;
	}

	.accent--primary :global(svg) {
		color: var(--accent-1);
	}

	.accent--destructive :global(svg) {
		color: var(--color-red);
	}

	.sr-only {
		block-size: 1px;
		clip: rect(0, 0, 0, 0);
		inline-size: 1px;
		overflow: hidden;
		position: absolute;
		white-space: nowrap;
	}
</style>
