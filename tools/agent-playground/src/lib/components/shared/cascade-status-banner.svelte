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
  import { z } from "zod";

  // The four shapes match `apps/atlasd/src/instance-events.ts`. We
  // parse defensively because the stream is open for future
  // `instance.daemon.*` / `instance.health.*` event types we don't
  // care about here — unknown events fall through.
  const SaturatedSchema = z.object({
    type: z.literal("cascade.queue_saturated"),
    at: z.string(),
    inFlight: z.number(),
    cap: z.number(),
    backlog: z.number(),
    deepestSignal: z.string().optional(),
  });
  const DrainedSchema = z.object({
    type: z.literal("cascade.queue_drained"),
    at: z.string(),
    inFlight: z.number(),
    cap: z.number(),
  });
  const TimeoutSchema = z.object({
    type: z.literal("cascade.queue_timeout"),
    at: z.string(),
    workspaceId: z.string(),
    signalId: z.string(),
    queuedMs: z.number(),
    correlationId: z.string().optional(),
  });
  const ReplacedSchema = z.object({
    type: z.literal("cascade.replaced"),
    at: z.string(),
    workspaceId: z.string(),
    signalId: z.string(),
    cancelledSessionId: z.string(),
    newSessionId: z.string(),
  });
  const InstanceEventSchema = z.union([
    SaturatedSchema,
    DrainedSchema,
    TimeoutSchema,
    ReplacedSchema,
  ]);
  const ReplayResponseSchema = z.object({ events: z.array(InstanceEventSchema) });
  type SaturatedEvent = z.infer<typeof SaturatedSchema>;
  type InstanceEvent = z.infer<typeof InstanceEventSchema>;

  // The most recent saturated event when there's no matching drained
  // after it. Reset to null when a drained event arrives.
  let saturatedState = $state<SaturatedEvent | null>(null);

  function applyEvent(event: InstanceEvent): void {
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

    let cancelled = false;

    // Hydrate first: scan recent cascade events to find the latest
    // saturated/drained pair. Walks newest-first, so the first
    // saturated/drained match wins. If the latest is a saturated
    // without a later drained, we render the banner immediately on
    // mount (no waiting for the next SSE publish).
    void (async () => {
      try {
        const res = await fetch("/api/daemon/api/instance/events?type=cascade.&limit=50");
        if (!res.ok || cancelled) return;
        const { events } = ReplayResponseSchema.parse(await res.json());
        for (const ev of events) {
          if (ev.type === "cascade.queue_saturated") {
            saturatedState = ev;
            break;
          }
          if (ev.type === "cascade.queue_drained") {
            saturatedState = null;
            break;
          }
        }
      } catch (err) {
        console.error("Failed to hydrate cascade state", err);
      }
    })();

    const es = new EventSource("/api/daemon/api/instance/events?stream=true");
    es.addEventListener("message", (e) => {
      try {
        const parsed = InstanceEventSchema.safeParse(JSON.parse(e.data));
        if (parsed.success) applyEvent(parsed.data);
      } catch (err) {
        console.error("Failed to parse instance SSE event", err);
      }
    });

    return () => {
      cancelled = true;
      es.close();
    };
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
