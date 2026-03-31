<!--
  Compact, uppercase label badge for type/category indicators.

  Used for agent types (BUILT-IN, LLM), signal providers (HTTP, Cron),
  skill sources (CATALOG, INLINE), tool names, and similar labels.

  @component
  @param {"success" | "info" | "warning" | "accent" | "neutral"} [variant="neutral"] - Color variant
-->

<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    variant?: "success" | "info" | "warning" | "accent" | "neutral";
    children: Snippet;
  };

  let { variant = "neutral", children }: Props = $props();
</script>

<span class="inline-badge" data-variant={variant}>
  {@render children()}
</span>

<style>
  .inline-badge {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .inline-badge[data-variant="success"] {
    background-color: var(--color-success);
    color: var(--color-surface-1);
  }

  .inline-badge[data-variant="info"] {
    background-color: var(--color-info);
    color: var(--color-surface-1);
  }

  .inline-badge[data-variant="warning"] {
    background-color: var(--color-warning);
    color: var(--color-surface-1);
  }

  .inline-badge[data-variant="accent"] {
    background-color: var(--color-accent);
    color: var(--color-surface-1);
  }

  .inline-badge[data-variant="neutral"] {
    background-color: var(--color-text);
    color: var(--color-surface-1);
  }
</style>
