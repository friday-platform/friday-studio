<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label?: string;
    variant?: "default" | "error";
    copyText?: string;
    maxLines?: number;
    children: Snippet;
  }

  let { label, variant = "default", copyText, maxLines, children }: Props = $props();

  let copied = $state(false);
  let expanded = $state(false);
  let contentEl = $state<HTMLDivElement>();

  const needsClamp = $derived.by(() => {
    if (!maxLines || expanded || !contentEl) return false;
    return contentEl.scrollHeight > contentEl.clientHeight;
  });

  function handleCopy() {
    if (!copyText) return;
    navigator.clipboard.writeText(copyText);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="formatted-data" class:error={variant === "error"}>
  {#if copyText}
    <button class="copy-btn" onclick={handleCopy}>
      {copied ? "Copied" : "Copy"}
    </button>
  {/if}
  {#if label}
    <h3>{label}</h3>
  {/if}
  <div
    class="content"
    class:clamped={maxLines && !expanded}
    style:--max-lines={maxLines}
    bind:this={contentEl}
  >
    {@render children()}
  </div>
  {#if needsClamp}
    <div class="expand-row">
      <button class="expand-btn" onclick={() => (expanded = true)}>Expand</button>
    </div>
  {/if}
</div>

<style>
  .formatted-data {
    background-color: var(--yellow-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    margin-block-start: var(--size-2);
    overflow: hidden;
    padding: var(--size-3) var(--size-12) var(--size-3) var(--size-3);
    position: relative;

    &.error {
      background-color: var(--red-1);
      color: var(--red-3);
    }

    h3 {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-4-5);
      opacity: 0.6;
    }

    :global(pre) {
      font-family: var(--font-family-monospace);
      font-size: var(--font-size-2);
      line-height: var(--font-lineheight-4);
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }

  .content.clamped {
    max-block-size: calc(21px * var(--max-lines));
    overflow: hidden;
  }

  .expand-row {
    align-items: center;
    background: linear-gradient(to top, var(--yellow-1) 50%, transparent 100%);
    block-size: var(--size-8);
    display: flex;
    justify-content: center;
    inline-size: 100%;
    inset-inline-start: 0;
    inset-block-end: 0;
    position: absolute;
  }

  .expand-btn {
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4-5);
    transition: all 200ms ease;

    &:hover {
      color: var(--color-text);
    }
  }

  .copy-btn {
    color: color-mix(in srgb, var(--color-text) 50%, transparent);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4-5);
    inset-block-start: var(--size-2);
    inset-inline-end: var(--size-3);
    position: absolute;
    transition: color 0.15s;

    &:hover {
      color: var(--color-text);
    }
  }
</style>
