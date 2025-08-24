<script lang="ts">
import { hasContext } from "svelte";
import type { HTMLInputAttributes } from "svelte/elements";
import { FIELD_CONTEXT, getFieldContext } from "$lib/components/form/context";

type Props = { checked: boolean; name?: string; disabled?: boolean };

const {
  checked = $bindable(),
  name,
  disabled = false,
  ...rest
}: Props & HTMLInputAttributes = $props();

let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}
</script>

<div>
	<input type="checkbox" bind:checked {disabled} {name} {id} {...rest} />
	{#if checked}
		√
	{/if}
</div>

<style>
	div {
		appearance: none;
		align-items: center;
		background-color: var(--background-1);
		border: 1px solid var(--border-3);
		border-radius: var(--radius-1);
		block-size: var(--size-4);
		display: flex;
		inline-size: var(--size-4);
		justify-content: center;
		position: relative;
		outline: none;

		input {
			appearance: none;
			position: absolute;
			inset: 0;
		}

		& :global(:has(input:disabled)) {
			background-color: var(--text-3);
			border-color: transparent;
			color: var(--text-1);
		}

		&:has(input:checked) {
			background-color: var(--accent-1);
			border-color: transparent;
		}

		& :global(:has(input:focus-visible)) {
			outline: 1px solid var(--accent-1);
			outline-offset: 2px;
		}

		& :global(svg) {
			color: var(--background-1);
			pointer-events: none;
		}
	}
</style>
