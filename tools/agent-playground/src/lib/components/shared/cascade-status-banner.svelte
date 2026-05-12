<!--
  Subscribes to the daemon's INSTANCE_EVENTS SSE feed and surfaces
  cascade-backlog state at the app shell level.

  - `cascade.queue_saturated` (without a matching drained) → persistent
    banner. Clears on `cascade.queue_drained`.
  - `cascade.queue_timeout`, `cascade.replaced` → one toast per event.
    Toasts are short-lived (closeDelay configured on the shared toaster)
    so the burst case self-rate-limits visually.

  On first mount the component hydrates state from the replay endpoint
  so a refresh after a saturation event already in flight still shows
  the banner — the SSE feed only carries new publishes.

  @component
-->
<script lang="ts">
  import { toast } from "@atlas/ui";
  import { browser } from "$app/environment";
  import {
    subscribeToCascadeEvents,
    type InstanceCascadeEvent,
  } from "$lib/shared-worker/client.ts";

  type SaturatedEvent = Extract<InstanceCascadeEvent, { type: "cascade.queue_saturated" }>;

  // The most recent saturated event when there's no matching drained
  // after it. Reset to null when a drained event arrives.
  let saturatedState = $state<SaturatedEvent | null>(null);

  function applyEvent(event: InstanceCascadeEvent): void {
    switch (event.type) {
      case "cascade.queue_saturated":
        saturatedState = event;
        return;
      case "cascade.queue_drained":
        saturatedState = null;
        return;
      case "cascade.queue_timeout":
        toast({
          title: "Cascade queue timeout",
          description: `${event.workspaceId} / ${event.signalId} sat ${formatMs(event.queuedMs)} before pickup`,
          error: true,
        });
        return;
      case "cascade.replaced":
        toast({
          title: "Cascade replaced",
          description: `${event.workspaceId} / ${event.signalId} aborted in favor of newer envelope`,
        });
        return;
    }
  }

  function formatMs(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
    return `${Math.round(ms / 60_000)}m`;
  }

  $effect(() => {
    if (!browser) return;

    // The wrapper handles replay-then-subscribe internally: it yields
    // the recent past first (so a banner state existing before the
    // page loaded is restored on mount), then live transitions. The
    // SharedWorker keeps one upstream /api/me/stream per browser
    // shared across every tab.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of subscribeToCascadeEvents({ signal: controller.signal })) {
          applyEvent(event);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Cascade events stream errored", error);
      }
    })();

    return () => controller.abort();
  });
</script>

{#if saturatedState}
  <div class="cascade-banner" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span class="message">
      Cascade queue saturated — {saturatedState.inFlight}/{saturatedState.cap} in flight,
      {saturatedState.backlog} queued
      {#if saturatedState.deepestSignal}
        (deepest: <code>{saturatedState.deepestSignal}</code>)
      {/if}
    </span>
  </div>
{/if}

<style>
  .cascade-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-warning, #d29922), transparent 80%);
    border-block-end: 1px solid color-mix(in srgb, var(--color-warning, #d29922), transparent 60%);
    color: var(--color-text);
    display: flex;
    flex: 0 0 auto;
    font-size: 13px;
    gap: 12px;
    inline-size: 100%;
    padding-block: 8px;
    padding-inline: 16px;
  }

  .dot {
    background: var(--color-warning, #d29922);
    block-size: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    inline-size: 8px;
  }

  .message {
    flex: 1 1 auto;

    code {
      background: color-mix(in srgb, var(--color-text), transparent 88%);
      border-radius: var(--radius-1);
      font-family: monospace;
      font-size: 0.92em;
      padding: 1px 5px;
    }
  }
</style>
