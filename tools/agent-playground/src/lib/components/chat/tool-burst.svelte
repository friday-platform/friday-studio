<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import { untrack } from "svelte";
  import ToolCallCard from "./tool-call-card.svelte";
  import { isError, isInProgress, needsUserAction } from "./tool-call-utils";
  import type { ToolCallDisplay } from "./types";

  interface Props {
    /** Tool calls that render inside the collapsible burst. */
    calls: ToolCallDisplay[];
    /** Optional reasoning text to render above the call list. */
    reasoning?: string;
    /** Forwarded to each call card. */
    onCredentialConnected?: (provider: string) => void;
  }

  const { calls, reasoning, onCredentialConnected }: Props = $props();

  /**
   * A burst is initially open if any call already needs user action — e.g.
   * a `display_artifact` or a `connect_service` that has reached
   * `output-available`. Computed once at render; native `<details>` owns
   * state thereafter.
   */
  const initialOpen = untrack(() => calls.some((c) => needsUserAction(c)));

  const anyRunning = $derived(calls.some((c) => isInProgress(c.state)));
  const anyError = $derived(calls.some((c) => isError(c.state)));
  const lastName = $derived(calls.at(-1)?.toolName ?? "");
  const summaryText = $derived(
    `${calls.length} tool call${calls.length === 1 ? "" : "s"}${lastName ? ` · last: ${lastName}` : ""}`,
  );

  const needsActionNow = $derived(calls.some((c) => needsUserAction(c)));

  let detailsEl: HTMLDetailsElement | undefined = $state();

  /**
   * Live-only shim: when a tool requiring user action lands in this burst
   * mid-stream, force the details element open. Effects do not run on the
   * server, so this is a no-op during SSR (the export pre-renders with
   * the initial-open attribute and never re-opens). Edge case: a
   * `connect_service` arriving in a burst the user explicitly closed
   * will re-open it — same behavior as the previous Map-based logic.
   */
  $effect(() => {
    if (needsActionNow && detailsEl && !detailsEl.open) {
      detailsEl.open = true;
    }
  });
</script>

<details bind:this={detailsEl} class="tool-burst" open={initialOpen}>
  <summary class="tool-burst-bar">
    <span class="burst-icon" aria-hidden="true">
      {#if anyRunning}
        <span class="burst-pulse"></span>
      {:else if anyError}
        <span class="burst-error-mark">!</span>
      {:else}
        <span class="burst-success-mark">✓</span>
      {/if}
    </span>
    <span class="burst-label">{summaryText}</span>
    <span class="burst-chevron" aria-hidden="true">
      <IconSmall.ChevronRight />
    </span>
  </summary>
  <div class="tool-burst-body">
    {#if reasoning}
      <div class="burst-reasoning">
        {#each reasoning.split("\n").filter((l) => l.trim()) as line}
          <div class="reasoning-line">
            <span class="reasoning-dot" aria-hidden="true"></span>
            <span class="reasoning-text">{line}</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="tool-call-list">
      {#each calls as call (call.toolCallId || call.toolName)}
        <ToolCallCard {call} {onCredentialConnected} />
      {/each}
    </div>
  </div>
</details>

<style>
  .tool-burst {
    display: flex;
    flex-direction: column;
    margin-block: var(--size-2);
  }

  .tool-burst-bar {
    align-items: center;
    background-color: var(--surface-dark);
    border-radius: var(--radius-3);
    color: var(--text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    list-style: none;
    padding: var(--size-1-5) var(--size-2-5);
    user-select: none;
  }

  .tool-burst-bar::-webkit-details-marker {
    display: none;
  }

  .burst-icon {
    align-items: center;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    justify-content: center;
  }

  .burst-pulse {
    animation: burst-pulse 1.5s ease-in-out infinite;
    background-color: var(--blue-primary);
    border-radius: 50%;
    display: inline-block;
    inline-size: 6px;
    block-size: 6px;
  }

  @keyframes burst-pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  .burst-error-mark {
    color: var(--red-primary);
    font-size: 12px;
    font-weight: var(--font-weight-6);
  }

  .burst-success-mark {
    color: var(--green-primary);
    font-size: 12px;
    font-weight: var(--font-weight-6);
  }

  .burst-label {
    color: var(--text);
    flex: 1;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .burst-chevron {
    color: color-mix(in srgb, var(--text-faded), transparent 50%);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 12px;
    block-size: 12px;
    transition: transform 150ms ease;
  }

  .burst-chevron :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .tool-burst[open] > .tool-burst-bar {
    border-radius: var(--radius-3) var(--radius-3) 0 0;
  }

  .tool-burst[open] > .tool-burst-bar .burst-chevron {
    transform: rotate(90deg);
  }

  .tool-burst-body {
    background-color: var(--surface-dark);
    border-radius: 0 0 var(--radius-3) var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: var(--size-1-5);
  }

  .tool-call-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .burst-reasoning {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    max-block-size: 200px;
    overflow-y: auto;
    padding-inline-end: var(--size-1);
    mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
  }

  .reasoning-line {
    align-items: baseline;
    display: flex;
    gap: var(--size-1-5);
  }

  .reasoning-dot {
    background-color: var(--text-faded);
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 3px;
    block-size: 3px;
    opacity: 0.35;
  }

  .reasoning-text {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    line-height: 1.45;
  }
</style>
