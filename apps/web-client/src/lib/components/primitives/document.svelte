<script lang="ts">
import { createCollapsible } from "@melt-ui/svelte";
import type { Snippet } from "svelte";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";

type Props = { name: string; children: Snippet; actions?: Snippet };

let { name, children, actions }: Props = $props();

const {
  elements: { root, trigger, content },
  states: { open },
} = createCollapsible({ forceVisible: true });
</script>

<article class="container" {...$root} use:root>
	<header>
		{#if actions}
			<DropdownMenu.Root
				positioning={{
					placement: 'bottom-end'
				}}
			>
				<DropdownMenu.Trigger>
					<h2>{name} <IconSmall.CaretDown /></h2>
				</DropdownMenu.Trigger>

				<DropdownMenu.Content>
					<DropdownMenu.List>
						{@render actions()}
					</DropdownMenu.List>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{:else}
			<h2>{name}</h2>
		{/if}
	</header>

	<div class="contents" use:content {...$content} class:expanded={$open}>
		{@render children()}
	</div>

	{#if !$open}
		<div class="expand">
			<button type="button" {...$trigger} use:trigger>
				<Icons.DoubleArrow />
				Expand
			</button>
		</div>
	{/if}
</article>

<style>
	article {
		background-color: var(--color-surface-2);
		border-radius: var(--radius-6);
		max-inline-size: 100%;
		inline-size: fit-content;
		overflow: hidden;
		padding: var(--size-0-5);
		position: relative;

		header {
			align-items: center;
			block-size: var(--size-10);
			display: flex;
			padding-inline: var(--size-3);

			h2 {
				align-items: center;
				display: flex;
				gap: var(--size-1);
				font-size: var(--font-size-2);
			}
		}
	}

	.expand {
		align-items: end;
		background: linear-gradient(to bottom, transparent, var(--color-surface-1) 90%);
		border-radius: var(--radius-5);
		display: flex;
		justify-content: center;
		inset-block: var(--size-10) var(--size-0-5);
		inset-inline: var(--size-0-5);
		position: absolute;
		padding-block: var(--size-4);
		z-index: var(--layer-1);

		button {
			align-items: center;
			color: var(--color-blue);
			display: flex;
			gap: var(--size-1);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
		}
	}

	.contents {
		background-color: var(--color-surface-1);
		border-radius: var(--radius-5);
		max-block-size: var(--size-48);
		overflow: hidden;
		overscroll-behavior-x: none;

		&.expanded {
			max-block-size: none;
			overflow: auto;
		}
	}
</style>
