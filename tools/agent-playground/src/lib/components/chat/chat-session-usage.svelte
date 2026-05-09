<script lang="ts">
  /**
   * Cumulative token + cache totals across every assistant message in the
   * current chat. Renders as a thin bar at the top of the chat surface.
   *
   * Reads from ChatMessage[] — no new fetches, no new persistence. When
   * none of the messages carry usage metadata (e.g. legacy chats from
   * before the field was added) the totals stay zero and the bar
   * collapses to a one-line "no usage data" notice.
   *
   * Layout: numbers right-aligned with extra inline padding so they
   * clear the chat surface's rounded corner. Default state is bare
   * numbers; holding Alt swaps in word labels (Input / Output / Cache
   * / turns) so a new operator can decode what each glyph means
   * without leaving the row. The cache hit ratio is hidden by default
   * and reveals on hover — it's only interesting when something looks
   * off, not on every glance.
   */
  import type { ChatMessage } from "./types.ts";

  interface Props {
    messages: ChatMessage[];
  }

  const { messages }: Props = $props();

  // Hold-to-reveal labels via the Alt key. One window-level listener
  // pair is enough because the bar is a single instance per chat.
  let altPressed = $state(false);
  $effect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.key === "Alt" && !altPressed) altPressed = true;
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === "Alt" && altPressed) altPressed = false;
    }
    function onBlur() {
      altPressed = false;
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  });

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
    <span class="metric">
      {#if altPressed}<span class="alt-label">Input</span>{:else}↑{/if}
      {fmt(totals.freshInputTokens)}
    </span>
    <span class="metric">
      {#if altPressed}<span class="alt-label">Output</span>{:else}↓{/if}
      {fmt(totals.outputTokens)}
    </span>
    {#if totals.cacheReadTokens > 0}
      <span class="cache-text" class:hit={cacheHitRatio > 0.3}>
        {#if altPressed}<span class="alt-label">Cache</span>{/if}
        {pct(cacheHitRatio)}
      </span>
    {/if}
    <span class="metric turns">
      {fmt(totals.turnsWithUsage)}
      <span class="turns-label">turn{totals.turnsWithUsage === 1 ? "" : "s"}</span>
    </span>
  </div>
{/if}

<style>
  /* The session usage bar is hidden by default and reveals when the
     chat surface is hovered. Triggering on a parent hover requires
     the parent to opt in: this component sets `--session-usage-state`
     via a data attribute on its root, but the actual show/hide rule
     keys off the surrounding `.chat-main:hover` selector applied in
     `user-chat.svelte`. Inside this scoped style block we only
     declare the resting and revealed states; the chooser sits with
     the parent layout so this component stays self-contained. */
  .session-usage {
    align-items: center;
    background: var(--surface-bright);
    border-block-end: 1px solid var(--border);
    color: var(--text-faded);
    display: flex;
    font-size: 0.7rem;
    /* Right-anchored stats with generous spacing between items. */
    gap: 1.25rem;
    justify-content: flex-end;
    /* Hidden state: collapse to zero height, transparent, but stay in
       the DOM so the layout doesn't shift when it appears. The
       parent layout file flips this open via a `:hover`-scoped rule
       on `.chat-main`. */
    max-block-size: 0;
    opacity: 0;
    overflow: hidden;
    padding-block: 0;
    padding-inline-end: 1.5rem;
    padding-inline-start: 0.75rem;
    pointer-events: none;
    transition: max-block-size 200ms ease, opacity 160ms ease, padding-block 200ms ease;
  }
  /* Revealed: max-height generous enough for the row's intrinsic
     height in any locale; opacity full; padding restored so the bar
     has its breathing room when shown. The selector scopes the
     reveal to a `.chat-main` ancestor that's hovered or focused-
     within. */
  :global(.chat-main:hover) .session-usage,
  :global(.chat-main:focus-within) .session-usage,
  .session-usage:hover {
    max-block-size: 3rem;
    opacity: 1;
    padding-block: 0.3rem;
    pointer-events: auto;
  }
  .metric {
    font-variant-numeric: tabular-nums;
  }
  .alt-label {
    color: var(--text-faded);
    font-weight: 500;
    letter-spacing: 0.04em;
    margin-inline-end: 0.2rem;
    text-transform: uppercase;
  }
  .cache-text {
    color: var(--text-faded);
    font-variant-numeric: tabular-nums;
  }
  .cache-text.hit {
    /* Muted green: half green-primary, half body-text. Stays low-noise
       in both themes. */
    color: color-mix(in srgb, var(--green-primary) 50%, var(--text));
  }
  .turns {
    color: var(--text-faded);
  }
  .turns-label {
    color: var(--text-faded);
    margin-inline-start: 0.2rem;
    text-transform: lowercase;
  }
</style>
