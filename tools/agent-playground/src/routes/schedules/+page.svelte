<script lang="ts">
  import { PageLayout } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { getDaemonClient } from "$lib/daemon-client";
  import { z } from "zod";

  const client = getDaemonClient();
  const queryClient = useQueryClient();

  const TimerSchema = z.object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    signalId: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    nextExecution: z.string(),
    lastExecution: z.string().nullable(),
    paused: z.boolean(),
  });

  const TimersResponseSchema = z.object({ timers: z.array(TimerSchema) });

  type Timer = z.infer<typeof TimerSchema>;

  const timersQuery = createQuery(() => ({
    queryKey: ["cron", "timers"],
    queryFn: async () => {
      const res = await client.cron.timers.$get();
      if (!res.ok) throw new Error(`Failed to fetch timers: ${res.status}`);
      return TimersResponseSchema.parse(await res.json());
    },
    refetchInterval: 30_000,
  }));

  const timers = $derived(timersQuery.data?.timers ?? []);

  // ---------------------------------------------------------------------------
  // Recent missed firings — fed by the WORKSPACE_EVENTS stream that
  // CronManager publishes to whenever an `onMissed: coalesce | catchup`
  // policy produces a make-up firing. Cross-workspace; per-workspace
  // pages can mount their own filtered view.
  // ---------------------------------------------------------------------------
  const ScheduleMissedEventSchema = z.object({
    type: z.literal("schedule.missed"),
    workspaceId: z.string(),
    signalId: z.string(),
    policy: z.enum(["coalesce", "catchup", "manual"]),
    missedCount: z.number(),
    firstMissedAt: z.string(),
    lastMissedAt: z.string(),
    scheduledAt: z.string(),
    firedAt: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    pending: z.boolean().optional(),
    id: z.string().optional(),
  });
  const EventsResponseSchema = z.object({ events: z.array(ScheduleMissedEventSchema) });
  type ScheduleMissedEvent = z.infer<typeof ScheduleMissedEventSchema>;

  const eventsQuery = createQuery(() => ({
    queryKey: ["workspace-events", "schedule.missed"],
    queryFn: async () => {
      const res = await fetch("/api/daemon/api/events?limit=50");
      if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
      return EventsResponseSchema.parse(await res.json());
    },
    refetchInterval: 60_000,
  }));

  const events = $derived(eventsQuery.data?.events ?? []);

  let actingOnEvent = $state<Set<string>>(new Set());

  function eventKey(e: ScheduleMissedEvent): string {
    return e.id ?? `${e.workspaceId}:${e.signalId}:${e.scheduledAt}`;
  }

  async function manualAction(event: ScheduleMissedEvent, action: "fire" | "dismiss") {
    const key = eventKey(event);
    actingOnEvent = new Set([...actingOnEvent, key]);
    try {
      const res = await fetch(`/api/daemon/api/events/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: event.workspaceId,
          signalId: event.signalId,
          scheduledAt: event.scheduledAt,
        }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["workspace-events", "schedule.missed"] });
    } catch (err) {
      console.error(`Failed to ${action} event:`, err);
    } finally {
      actingOnEvent = new Set([...actingOnEvent].filter((k) => k !== key));
    }
  }

  let toggling = $state<Set<string>>(new Set());

  function timerKey(t: Timer) {
    return `${t.workspaceId}:${t.signalId}`;
  }

  async function togglePause(timer: Timer) {
    const key = timerKey(timer);
    toggling = new Set([...toggling, key]);
    try {
      const action = timer.paused ? "resume" : "pause";
      const res = await fetch(
        `/api/daemon/api/cron/timers/${encodeURIComponent(timer.workspaceId)}/${encodeURIComponent(timer.signalId)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["cron", "timers"] });
    } catch (err) {
      console.error("Failed to toggle schedule:", err);
    } finally {
      toggling = new Set([...toggling].filter((k) => k !== key));
    }
  }

  function formatRelative(iso: string | null): string {
    if (!iso) return "never";
    const date = new Date(iso);
    const now = Date.now();
    const diff = date.getTime() - now;
    const absDiff = Math.abs(diff);
    const past = diff < 0;
    if (absDiff < 60_000) return past ? "just now" : "< 1 min";
    if (absDiff < 3_600_000) {
      const mins = Math.round(absDiff / 60_000);
      return past ? `${mins}m ago` : `in ${mins}m`;
    }
    if (absDiff < 86_400_000) {
      const hrs = Math.round(absDiff / 3_600_000);
      return past ? `${hrs}h ago` : `in ${hrs}h`;
    }
    const days = Math.round(absDiff / 86_400_000);
    return past ? `${days}d ago` : `in ${days}d`;
  }

  function humanizeCron(expr: string, tz: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return expr;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const segments: string[] = [];
    const everyNMin = minute.match(/^\*\/(\d+)$/);
    const everyNHour = hour.match(/^\*\/(\d+)$/);
    if (minute === "*" && hour === "*") segments.push("every minute");
    else if (everyNMin && hour === "*") segments.push(`every ${everyNMin[1]} min`);
    else if (minute === "*" && everyNHour) segments.push(`every ${everyNHour[1]} hours`);
    else if (minute.match(/^\d+$/) && hour === "*") segments.push(`hourly at :${minute.padStart(2, "0")}`);
    else if (minute.match(/^\d+$/) && hour.match(/^\d+$/)) segments.push(formatTime(Number(hour), Number(minute)));
    else if (everyNMin && hour.match(/^\d+$/)) segments.push(`every ${everyNMin[1]} min from ${formatTime(Number(hour), 0)}`);
    if (dayOfWeek !== "*") {
      const names = dayOfWeek.split(",").map((d) => dayNames[Number(d)] ?? d).filter(Boolean);
      if (names.length > 0) segments.push(names.join(", "));
    }
    if (dayOfMonth !== "*") segments.push(`day ${dayOfMonth}`);
    if (month !== "*") {
      const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const names = month.split(",").map((m) => monthNames[Number(m)] ?? m).filter(Boolean);
      if (names.length > 0) segments.push(names.join(", "));
    }
    return segments.length > 0 ? `${segments.join(" · ")} · ${tz}` : `${expr} · ${tz}`;
  }

  function formatTime(h: number, m: number): string {
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  }
</script>

<PageLayout.Root>
  <PageLayout.Title>Schedules</PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      {#if timersQuery.isLoading}
        <div class="empty-state"><p>Loading schedules…</p></div>
      {:else if timersQuery.isError}
        <div class="empty-state"><p>Failed to load schedules</p></div>
      {:else if timers.length === 0}
        <div class="empty-state">
          <p>No scheduled signals found.</p>
          <span class="empty-hint">
            Add a signal with <code>provider: schedule</code>
            to a workspace.
          </span>
        </div>
      {:else}
        <section class="section">
          <header class="section-header">
            <h2>Active</h2>
            <span class="count">{timers.filter((t) => !t.paused).length}</span>
          </header>
          <div class="signal-list">
            {#each timers as timer (timerKey(timer))}
              {@const key = timerKey(timer)}
              {@const busy = toggling.has(key)}
              <div class="signal-row" class:is-paused={timer.paused}>
                <a class="row-main" href="/platform/{timer.workspaceId}/signal/{timer.signalId}">
                  <span class="signal-id">{timer.signalId}</span>
                  <span class="signal-meta">
                    <span class="ws-name">{timer.workspaceName}</span>
                    <span class="sep">·</span>
                    <span class="cron-human">
                      {humanizeCron(timer.schedule, timer.timezone)}
                    </span>
                  </span>
                </a>

                <div class="row-right">
                  <div class="timing">
                    <span class="timing-label">next</span>
                    <span class="timing-value" class:muted={timer.paused}>
                      {timer.paused ? "—" : formatRelative(timer.nextExecution)}
                    </span>
                    {#if timer.lastExecution}
                      <span class="timing-label">last</span>
                      <span class="timing-value muted">
                        {formatRelative(timer.lastExecution)}
                      </span>
                    {/if}
                  </div>

                  <span
                    class="badge"
                    class:badge-active={!timer.paused}
                    class:badge-paused={timer.paused}
                  >
                    {timer.paused ? "Paused" : "Active"}
                  </span>

                  <button
                    class="action-btn"
                    class:action-resume={timer.paused}
                    disabled={busy}
                    onclick={() => togglePause(timer)}
                  >
                    {busy ? "…" : timer.paused ? "Resume" : "Pause"}
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if events.length > 0}
        <section class="section">
          <header class="section-header">
            <h2>Missed schedules</h2>
            <span class="count">{events.length}</span>
          </header>
          <div class="signal-list">
            {#each events as event (eventKey(event))}
              {@const busy = actingOnEvent.has(eventKey(event))}
              <div class="signal-row event-row" class:event-pending={event.pending}>
                <a class="row-main" href="/platform/{event.workspaceId}/signal/{event.signalId}">
                  <span class="signal-id">
                    {event.signalId}
                    <span
                      class="badge badge-event"
                      class:badge-pending={event.pending}
                    >{event.policy}{event.policy === "coalesce" && event.missedCount > 1
                        ? ` ×${event.missedCount}`
                        : ""}{event.pending ? " · pending" : ""}</span>
                  </span>
                  <span class="signal-meta">
                    <span class="ws-name">{event.workspaceId}</span>
                    <span class="sep">·</span>
                    <span class="cron-human">
                      {humanizeCron(event.schedule, event.timezone)}
                    </span>
                    <span class="sep">·</span>
                    <span class="event-time">
                      missed {formatRelative(event.scheduledAt)}
                    </span>
                  </span>
                </a>

                {#if event.policy === "manual" && event.pending}
                  <div class="row-right">
                    <button
                      class="action-btn action-resume"
                      disabled={busy}
                      onclick={() => manualAction(event, "fire")}
                    >
                      {busy ? "…" : "Fire now"}
                    </button>
                    <button
                      class="action-btn"
                      disabled={busy}
                      onclick={() => manualAction(event, "dismiss")}
                    >
                      Dismiss
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </PageLayout.Content>
    <PageLayout.Sidebar>
      <p class="subtitle">All cron triggers across every space</p>
      {#if events.length > 0}
        <p class="subtitle subtle">
          A missed schedule appears here when an <code>onMissed:
          coalesce</code> or <code>catchup</code> policy fires for cron
          slots the daemon was down for. Window: 30 days.
        </p>
      {/if}
    </PageLayout.Sidebar>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  /* ── Empty state ─────────────────────────────────────────────────── */

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);

    code {
      font-family: monospace;
    }
  }

  /* ── Section ─────────────────────────────────────────────────────── */

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-3);
  }

  .section-header h2 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .count {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
  }

  /* ── Signal rows ─────────────────────────────────────────────────── */

  .signal-list {
    display: flex;
    flex-direction: column;
  }

  .signal-row {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    column-gap: var(--size-4);
    display: grid;
    grid-template-columns: 1fr auto;
    padding: var(--size-3) var(--size-1);
    position: relative;
    z-index: 1;
  }

  .signal-row::before {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-4);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .signal-row:hover::before {
    opacity: 1;
  }

  .signal-row.is-paused .row-main {
    opacity: 0.45;
  }

  /* ── Row main (left) ─────────────────────────────────────────────── */

  .row-main {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
    text-decoration: none;
  }

  .row-main::after {
    content: "";
    cursor: pointer;
    inset: 0;
    position: absolute;
    z-index: 0;
  }

  .signal-id {
    font-family: monospace;
    font-size: var(--font-size-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signal-meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sep {
    opacity: 0.4;
  }

  /* ── Row right (actions) ─────────────────────────────────────────── */

  .row-right {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }

  .timing {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .timing-label {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-1);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .timing-value {
    font-size: var(--font-size-1);
    min-inline-size: 4rem;
  }

  .timing-value.muted {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .badge {
    border-radius: var(--radius-round);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 2px var(--size-2);
    white-space: nowrap;
  }

  .badge-active {
    background-color: color-mix(in srgb, var(--color-success, #238636), transparent 80%);
    color: var(--color-success, #238636);
  }

  .badge-paused {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .badge-event {
    background-color: color-mix(in srgb, var(--color-warning, #d29922), transparent 80%);
    color: var(--color-warning, #d29922);
    margin-inline-start: var(--size-2);
  }

  .badge-pending {
    background-color: color-mix(in srgb, var(--color-accent, #1f6feb), transparent 80%);
    color: var(--color-accent, #1f6feb);
  }

  .event-row.event-pending {
    border-left: 3px solid var(--color-accent, #1f6feb);
  }

  .event-time {
    font-variant-numeric: tabular-nums;
  }

  .subtle {
    margin-top: var(--size-3);
    font-size: var(--font-size-1);
  }

  .action-btn {
    background-color: transparent;
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    inline-size: 5rem;
    padding: var(--size-1) var(--size-3);
    pointer-events: auto;
    position: relative;
    text-align: center;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    z-index: 2;
  }

  .action-btn:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
  }

  .action-btn.action-resume:hover:not(:disabled) {
    border-color: var(--color-success, #238636);
    color: var(--color-success, #238636);
  }

  .action-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
