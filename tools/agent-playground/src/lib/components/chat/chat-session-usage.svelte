<script lang="ts">
  /**
   * Cumulative token + cache totals across every assistant message in the
   * current chat. Renders as a thin bar at the top of the chat surface.
   *
   * Reads from ChatMessage[] — no new fetches, no new persistence. When
   * none of the messages carry usage metadata (e.g. legacy chats from
   * before the field was added) the totals stay zero and the bar
   * collapses to a one-line "no usage data" notice.
   */
  import type { ChatMessage } from "./types.ts";

  interface Props {
    messages: ChatMessage[];
  }

  const { messages }: Props = $props();

  const totals = $derived.by(() => {
    let totalInputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let turnsWithUsage = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const usage = msg.metadata?.usage;
      if (!usage) continue;
      turnsWithUsage++;
      totalInputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      cacheReadTokens += usage.cacheReadTokens ?? 0;
      cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    }
    // The badge shows fresh input across the session — bytes that
    // actually paid the full input rate. Total prompt size including
    // cached prefix is in the tooltip + /usage page; surfacing it here
    // would scale linearly with turn count even when the cache is
    // serving 97% of every prompt.
    const freshInputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
    return {
      totalInputTokens,
      freshInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      turnsWithUsage,
    };
  });

  const hasUsage = $derived(totals.turnsWithUsage > 0);
  const cacheHitRatio = $derived(
    totals.totalInputTokens > 0 && totals.cacheReadTokens > 0
      ? totals.cacheReadTokens / totals.totalInputTokens
      : 0,
  );

  function fmt(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function pct(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
  }
</script>

{#if hasUsage}
  <div
    class="session-usage"
    title={`Fresh input:  ${totals.freshInputTokens.toLocaleString()}\nTotal prompt: ${totals.totalInputTokens.toLocaleString()} (incl. cached prefix)\nOutput:       ${totals.outputTokens.toLocaleString()}\nCache read:   ${totals.cacheReadTokens.toLocaleString()}\nCache write:  ${totals.cacheWriteTokens.toLocaleString()}`}
  >
    <span class="label">Session</span>
    <span class="metric">↑ {fmt(totals.freshInputTokens)}</span>
    <span class="metric">↓ {fmt(totals.outputTokens)}</span>
    {#if totals.cacheReadTokens > 0}
      <span class="metric cache" class:hit={cacheHitRatio > 0.3}>
        cache {pct(cacheHitRatio)}
      </span>
    {/if}
    <span class="turns">{totals.turnsWithUsage} turn{totals.turnsWithUsage === 1 ? "" : "s"}</span>
  </div>
{/if}

<style>
  .session-usage {
    align-items: center;
    background: var(--surface-bright);
    border-block-end: 1px solid var(--border);
    color: var(--text-faded);
    display: flex;
    font-size: 0.7rem;
    gap: 0.5rem;
    padding-block: 0.25rem;
    padding-inline: 0.75rem;
  }
  .label {
    color: var(--text-faded);
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .metric {
    font-variant-numeric: tabular-nums;
  }
  .metric.cache {
    background: var(--highlight);
    border-radius: 0.4rem;
    padding-block: 0.1rem;
    padding-inline: 0.35rem;
  }
  .metric.cache.hit {
    background: color-mix(in srgb, var(--green-primary) 18%, transparent);
    color: var(--green-primary);
  }
  .turns {
    color: var(--text-faded);
    margin-inline-start: auto;
  }
</style>
