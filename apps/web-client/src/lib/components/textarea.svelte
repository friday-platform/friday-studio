<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";

  type Props = {
    value: string | null | undefined;
    placeholder?: string;
    size?: "regular" | "small";
    autoFocus?: boolean;
    disabled?: boolean;
    onResize?: (value: number) => void;
  } & HTMLTextareaAttributes;

  let {
    value = $bindable(),
    placeholder,
    size: _size = "regular",
    autoFocus: _autoFocus = false,
    disabled = false,
    onResize,
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

    if (onResize) {
      onResize(bounds.height);
    }
  }
</script>

<div>
  <p bind:this={text}>
    {value}
    <br />
  </p>
  <textarea
    bind:this={textarea}
    {disabled}
    name="message"
    {placeholder}
    bind:value
    {...rest}
    minlength="1"
  ></textarea>
</div>

<style>
  div {
    position: relative;
    inline-size: 100%;
  }

  p,
  textarea {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-3);
    padding-block: var(--size-2-5);
    min-block-size: var(--size-10);
    word-break: break-word;
    transform: translate3d(0, 0, 0);
  }

  textarea {
    background-color: transparent;
    display: block;
    caret-color: var(--color-yellow);
    inline-size: 100%;
    resize: none;
    scrollbar-width: thin;

    &:disabled {
      opacity: 1;
    }

    &:focus {
      outline: none;
    }

    &::placeholder {
      color: color-mix(in oklch, var(--color-text) 50%, transparent);
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
