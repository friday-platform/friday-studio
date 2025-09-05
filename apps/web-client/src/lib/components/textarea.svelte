<script lang="ts">
import { onMount } from "svelte";
import type { HTMLTextareaAttributes } from "svelte/elements";

type Props = {
  onTextChange: (value: string) => void;
  value: string | null | undefined;
  placeholder?: string;
  size?: "regular" | "small";
  autoFocus?: boolean;
  disabled?: boolean;
} & HTMLTextareaAttributes;

let {
  onTextChange,
  value = $bindable(),
  placeholder,
  size = "regular",
  autoFocus = false,
  disabled = false,
  ...rest
}: Props = $props();

let text: HTMLParagraphElement | null = $state(null);
let textarea: HTMLTextAreaElement | null = $state(null);

$effect(() => {
  updateDimensions(value);
});

function updateDimensions(_value?: string | null | undefined) {
  if (!textarea || !text) return;

  text.innerHTML = `${textarea.value} <br />`;
  const bounds = text.getBoundingClientRect();
  textarea.style.height = `${bounds.height}px`;
}
</script>

<div>
	<p bind:this={text}>{value} <br /></p>
	<textarea
		bind:this={textarea}
		{disabled}
		name="message"
		{placeholder}
		{value}
		{...rest}
		minlength="1"
		oninput={(e) => onTextChange(e.currentTarget.value)}
	></textarea>
</div>

<style>
	div {
		position: relative;
		inline-size: 100%;
	}

	p,
	textarea {
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-4);
		line-height: var(--font-lineheight-3);
		padding-inline: var(--size-3);
		padding-block: var(--size-2);
		word-break: break-all;
	}

	textarea {
		background-color: transparent;
		border-radius: var(--radius-4);
		box-shadow: var(--shadow-1);
		caret-color: var(--accent-1);
		inline-size: 100%;
		min-block-size: var(--size-9);
		resize: none;
		scrollbar-width: thin;

		&:focus {
			outline: none;
		}

		&::placeholder {
			color: color-mix(in oklch, var(--text-3) 70%, transparent);
		}
	}

	p {
		opacity: 0;
		inline-size: auto;
		inset-block-start: 0;
		inset-inline-start: 0;
		pointer-events: none;
		white-space: pre-wrap;
		position: absolute;
	}
</style>
