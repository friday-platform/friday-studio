<script lang="ts">
  /**
   * Inline per-turn usage badge for assistant messages.
   *
   * Reads `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`
   * from the message's `metadata.usage` (stamped by workspace-chat from
   * `streamText.totalUsage`). Renders a compact summary; hover surfaces
   * the breakdown.
   *
   * Cache-hit attribution to specific system blocks is NOT exact —
   * providers report a single cacheReadTokens count, not per-breakpoint
   * matches. The breakdown tooltip notes this.
   */
  interface Props {
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    provider?: string;
  }

  const { usage, provider }: Props = $props();

  const inputTokens = $derived(usage.inputTokens ?? 0);
  const outputTokens = $derived(usage.outputTokens ?? 0);
  const cacheReadTokens = $derived(usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = $derived(usage.cacheWriteTokens ?? 0);

  // Cache hit ratio = (read tokens) / (read + non-cached input). When the
  // provider doesn't surface cache_read tokens (some non-Anthropic /
  // non-OpenAI), the ratio stays 0 and the cache pill is hidden.
  const cacheHitRatio = $derived(
    inputTokens > 0 && cacheReadTokens > 0
      ? cacheReadTokens / inputTokens
      : 0,
  );
  const showCachePill = $derived(cacheReadTokens > 0 || cacheWriteTokens > 0);

  /** 1234 → "1.2K", 1_234_567 → "1.2M" */
  function fmt(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function pct(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
  }

  const tooltip = $derived(
    [
      `Input:  ${inputTokens.toLocaleString()}`,
      `Output: ${outputTokens.toLocaleString()}`,
      cacheReadTokens > 0
        ? `Cache read:  ${cacheReadTokens.toLocaleString()} (${pct(cacheHitRatio)} of input)`
        : null,
      cacheWriteTokens > 0
        ? `Cache write: ${cacheWriteTokens.toLocaleString()}`
        : null,
      provider ? `\nProvider: ${provider}` : null,
      // Per-block cache attribution would require a provider feature
      // that doesn't exist; the tooltip names the limitation so the
      // breakdown isn't read as authoritative.
      "\nCache hit %s are aggregate, not per-block.",
    ]
      .filter((s): s is string => s !== null)
      .join("\n"),
  );
</script>

<span class="usage-badge" title={tooltip}>
  <span class="pill">↑ {fmt(inputTokens)}</span>
  <span class="pill">↓ {fmt(outputTokens)}</span>
  {#if showCachePill}
    <span class="pill cache" class:hit={cacheHitRatio > 0.3}>
      cache {pct(cacheHitRatio)}
    </span>
  {/if}
</span>

<style>
  .usage-badge {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    font-size: 0.7rem;
    line-height: 1;
    color: var(--text-tertiary, #888);
    cursor: default;
    user-select: none;
  }
  .pill {
    padding: 0.125rem 0.375rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary, #f3f3f3);
    font-variant-numeric: tabular-nums;
  }
  .pill.cache {
    background: var(--surface-secondary, #f3f3f3);
    color: var(--text-tertiary, #888);
  }
  .pill.cache.hit {
    background: var(--accent-soft, #d9f0d4);
    color: var(--accent-fg, #2a6c1e);
  }
</style>
