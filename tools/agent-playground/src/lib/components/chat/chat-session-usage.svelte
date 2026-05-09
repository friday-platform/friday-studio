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
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let turnsWithUsage = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const usage = msg.metadata?.usage;
      if (!usage) continue;
      turnsWithUsage++;
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      cacheReadTokens += usage.cacheReadTokens ?? 0;
      cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turnsWithUsage };
  });

  const hasUsage = $derived(totals.turnsWithUsage > 0);
  const cacheHitRatio = $derived(
    totals.inputTokens > 0 && totals.cacheReadTokens > 0
      ? totals.cacheReadTokens / totals.inputTokens
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
  <div class="session-usage">
    <span class="label">Session</span>
    <span class="metric">↑ {fmt(totals.inputTokens)}</span>
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
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.25rem 0.75rem;
    border-bottom: 1px solid var(--border-subtle, #eee);
    font-size: 0.7rem;
    color: var(--text-tertiary, #888);
    background: var(--surface-secondary, #fafafa);
  }
  .label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    color: var(--text-quaternary, #aaa);
  }
  .metric {
    font-variant-numeric: tabular-nums;
  }
  .metric.cache {
    padding: 0.1rem 0.35rem;
    border-radius: 0.4rem;
    background: var(--surface-tertiary, #f0f0f0);
  }
  .metric.cache.hit {
    background: var(--accent-soft, #d9f0d4);
    color: var(--accent-fg, #2a6c1e);
  }
  .turns {
    margin-left: auto;
    color: var(--text-quaternary, #aaa);
  }
</style>
