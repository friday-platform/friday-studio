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

  const totalInputTokens = $derived(usage.inputTokens ?? 0);
  const outputTokens = $derived(usage.outputTokens ?? 0);
  const cacheReadTokens = $derived(usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = $derived(usage.cacheWriteTokens ?? 0);

  // Show "fresh" input — the bytes the provider charged at the full
  // input rate this turn — not the total prompt size. The total
  // includes cached prefix bytes that are billed at ~10% of the fresh
  // rate; surfacing the total at the badge level overstates cost on
  // every turn (every long-running chat would look like "↑ 19K"
  // forever even when 97% is cached). The cache pill conveys the
  // savings; the tooltip shows the full breakdown.
  const freshInputTokens = $derived(Math.max(0, totalInputTokens - cacheReadTokens));
  const cacheHitRatio = $derived(
    totalInputTokens > 0 && cacheReadTokens > 0
      ? cacheReadTokens / totalInputTokens
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
      `Fresh input:  ${freshInputTokens.toLocaleString()}`,
      `Total prompt: ${totalInputTokens.toLocaleString()} (incl. cached prefix)`,
      `Output:       ${outputTokens.toLocaleString()}`,
      cacheReadTokens > 0
        ? `Cache read:   ${cacheReadTokens.toLocaleString()} (${pct(cacheHitRatio)} of total prompt)`
        : null,
      cacheWriteTokens > 0
        ? `Cache write:  ${cacheWriteTokens.toLocaleString()}`
        : null,
      provider ? `\nProvider: ${provider}` : null,
      // Per-block cache attribution would require a provider feature
      // that doesn't exist; the tooltip names the limitation so the
      // breakdown isn't read as authoritative.
      "\nCache hit % is aggregate, not per-block.",
    ]
      .filter((s): s is string => s !== null)
      .join("\n"),
  );
</script>

<span class="usage-badge" title={tooltip}>
  <span class="pill">↑ {fmt(freshInputTokens)}</span>
  <span class="pill">↓ {fmt(outputTokens)}</span>
  {#if showCachePill}
    <span class="cache-text" class:hit={cacheHitRatio > 0.3}>
      cache {pct(cacheHitRatio)}
    </span>
  {/if}
</span>

<style>
  .usage-badge {
    align-items: center;
    color: var(--text-faded);
    cursor: default;
    display: inline-flex;
    font-size: 0.7rem;
    gap: 0.25rem;
    line-height: 1;
    user-select: none;
  }
  /* Plain text — no chip background — so the row reads as inline
     stats next to the message rather than a row of UI controls. The
     class is still named `.pill` for parity with similar widgets in
     other components. */
  .pill {
    font-variant-numeric: tabular-nums;
  }
  /* Cache stat is text, not a pill — keeps the row low-noise. Faded
     when the hit ratio is poor (cool but uninteresting); green when
     it's good (the bit worth glancing at). */
  .cache-text {
    color: var(--text-faded);
    font-variant-numeric: tabular-nums;
  }
  .cache-text.hit {
    /* Muted green: half green-primary, half body-text. The text token
       flips between slate (light mode) and cream (dark mode), so the
       result is a desaturated olive-toned green in either theme rather
       than the eye-grabbing pure --green-primary. */
    color: color-mix(in srgb, var(--green-primary) 50%, var(--text));
  }
</style>
