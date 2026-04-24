<script lang="ts">
  type Props = {
    value: string;
    placeholder?: string;
    onsubmit?: () => void;
    onblur?: (value: string) => void;
    onchange?: (value: string) => void;
  };

  let { value, placeholder = undefined, onsubmit, onblur, onchange }: Props = $props();
  let mirror: HTMLSpanElement | null = $state(null);
  let textarea: HTMLTextAreaElement | null = $state(null);
  let internal = $derived(value);

  $effect(() => {
    resize(internal);
  });

  function resize(_value?: string) {
    if (!textarea || !mirror) return;
    mirror.textContent = textarea.value || "\u00A0";
    textarea.style.height = `${mirror.getBoundingClientRect().height}px`;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onsubmit?.();
    }
  }
</script>

<h1 class="title-wrap">
  <span class="title-mirror" bind:this={mirror}>{internal || "\u00A0"}</span>
  <textarea
    class="title-input"
    bind:this={textarea}
    bind:value={internal}
    {placeholder}
    onkeydown={handleKeydown}
    oninput={() => onchange?.(internal)}
    onblur={() => onblur?.(internal)}
    rows={1}
  ></textarea>
</h1>

<style>
  .title-wrap {
    inline-size: 100%;
    position: relative;
  }

  .title-mirror,
  .title-input {
    font-family: inherit;
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
    word-break: break-word;
  }

  .title-mirror {
    display: block;
    inline-size: 100%;
    inset-block-start: 0;
    inset-inline-start: 0;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    white-space: pre-wrap;
  }

  .title-input {
    background: none;
    border: none;
    color: inherit;
    display: block;
    inline-size: 100%;
    outline: none;
    padding: 0;
    resize: none;

    &::placeholder {
      color: var(--color-text);
      opacity: 0.6;
    }
  }
</style>
