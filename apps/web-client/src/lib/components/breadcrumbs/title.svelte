<script lang="ts">
import type { Snippet } from "svelte";
import type { Writable } from "svelte/store";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { IconSmall } from "$lib/components/icons/small";

type Props = {
  children: Snippet;
  prepend?: Snippet;
  actions?: Snippet<[Writable<boolean>]>;
  menuVisible?: boolean;
};

let { children, prepend, actions, menuVisible = true }: Props = $props();
</script>

{#snippet trigger()}
	<div class="title" class:actions={actions !== undefined}>
		{#if prepend}
			<span class="prepend">
				{@render prepend()}
			</span>
		{/if}

		<span class="label">
			{@render children()}
		</span>

		{#if actions}
			<IconSmall.CaretDown />
		{/if}
	</div>
{/snippet}

{#if actions}
	<DropdownMenu.Root
		positioning={{
			placement: 'bottom-start',
			gutter: 0,
			offset: { crossAxis: -6, mainAxis: 8 }
		}}
	>
		{#snippet children(open)}
			<DropdownMenu.Trigger>
				{@render trigger()}
			</DropdownMenu.Trigger>

			<DropdownMenu.Content visible={menuVisible}>
				{@render actions(open)}
			</DropdownMenu.Content>
		{/snippet}
	</DropdownMenu.Root>
{:else}
	{@render trigger()}
{/if}

<style>
	.title {
		align-items: center;
		block-size: var(--size-6);
		border-radius: var(--radius-3);
		cursor: default;
		display: flex;
		flex: 1 1 auto;
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		inline-size: max-content;
		margin-inline: calc(-1 * var(--size-2)) calc(-1 * var(--size-1));
		padding-inline: var(--size-2) var(--size-1);
		padding-block: var(--size-1);
		transition: all 150ms ease;

		&:has(.prepend) {
			padding-inline-start: var(--size-1);
			margin-inline-start: calc(-1 * var(--size-1));
		}

		& :global(svg) {
			flex: none;
			opacity: 0.5;
		}

		&.actions:hover {
			background-color: var(--color-surface-2);
		}
	}

	:global(:focus-visible) .title {
		background-color: var(--color-surface-2);
	}

	.prepend {
		&:empty {
			margin-inline-end: calc(-1 * var(--size-2));
		}

		/* margin if prepend has values */
		&:not(:empty) {
			align-items: center;
			block-size: var(--size-4);
			display: flex;
			flex: none;
			inline-size: var(--size-4);
			justify-content: center;
		}
	}

	.label {
		inline-size: 100%;
		line-height: var(--font-lineheight-1);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
