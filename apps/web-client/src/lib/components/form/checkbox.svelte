<script lang="ts">
	import { FIELD_CONTEXT, getFieldContext } from '$lib/components/form/context';
	import { hasContext } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = {
		checked: boolean;
		name?: string;
		disabled?: boolean;
		// checked is bound so we don't need to separately pass the value, but we should pass e
		onUpdate?: (e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) => void;
	};

	let {
		checked = $bindable(),
		name,
		disabled = false,
		onUpdate,
		...rest
	}: Props & HTMLButtonAttributes = $props();

	let id = $state<string>();

	if (hasContext(FIELD_CONTEXT)) {
		id = getFieldContext().id;
	}
</script>

<button
	role="checkbox"
	{disabled}
	{name}
	aria-checked={checked}
	class="checked-{checked}"
	onclick={(e) => {
		checked = !checked;
		if (onUpdate) {
			onUpdate(e);
		}
	}}
	{id}
	{...rest}
>
	{#if checked}
		√
	{/if}
</button>

<style>
	button {
		appearance: none;
		align-items: center;
		background-color: var(--background-1);
		border: 1px solid var(--border-3);
		border-radius: var(--radius-1);
		block-size: var(--size-4);
		display: flex;
		inline-size: var(--size-4);
		justify-content: center;
		outline: none;

		&:disabled {
			background-color: var(--text-3);
			border-color: transparent;
			color: var(--text-1);
		}

		&:not(:disabled).checked-true {
			background-color: var(--accent-1);
			border-color: transparent;
		}

		&:focus-visible {
			outline: 1px solid var(--accent-1);
			outline-offset: 2px;
		}

		& :global(svg) {
			color: var(--background-1);
			pointer-events: none;
		}
	}
</style>
