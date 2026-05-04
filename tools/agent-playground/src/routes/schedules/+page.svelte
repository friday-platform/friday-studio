<script lang="ts">
  import { IconSmall, PageLayout } from "@atlas/ui";
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
    status: z.enum(["pending", "fired", "dismissed", "auto"]).optional(),
    pending: z.boolean().optional(),
    actionedAt: z.string().optional(),
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

  let actingOnGroup = $state<Set<string>>(new Set());
  let openMenuFor = $state<string | null>(null);

  function eventKey(e: ScheduleMissedEvent): string {
    return e.id ?? `${e.workspaceId}:${e.signalId}:${e.scheduledAt}`;
  }

  function groupKey(workspaceId: string, signalId: string): string {
    return `${workspaceId}:${signalId}`;
  }

  /**
   * Roll up pending manual events by (workspaceId, signalId) so the
   * UI shows ONE actionable row per signal even when the daemon
   * caught N missed slots. The most-recent missed slot is the one
   * the row displays as "missed Xm ago"; the count drives the
   * "Fire all (N)" menu option.
   */
  interface PendingGroup {
    workspaceId: string;
    signalId: string;
    schedule: string;
    timezone: string;
    count: number;
    /** Most recent missed slot — drives the "missed Xm ago" text. */
    latestMissedAt: string;
    /** Earliest missed slot — drives "covers slots since Xm ago" tooltip text. */
    earliestMissedAt: string;
  }

  const pendingGroups = $derived.by((): PendingGroup[] => {
    const byKey = new Map<string, PendingGroup>();
    for (const e of pendingEvents) {
      const k = groupKey(e.workspaceId, e.signalId);
      const existing = byKey.get(k);
      if (existing) {
        existing.count++;
        if (e.scheduledAt > existing.latestMissedAt) existing.latestMissedAt = e.scheduledAt;
        if (e.scheduledAt < existing.earliestMissedAt) existing.earliestMissedAt = e.scheduledAt;
      } else {
        byKey.set(k, {
          workspaceId: e.workspaceId,
          signalId: e.signalId,
          schedule: e.schedule,
          timezone: e.timezone,
          count: 1,
          latestMissedAt: e.scheduledAt,
          earliestMissedAt: e.scheduledAt,
        });
      }
    }
    // Most-recent first
    return Array.from(byKey.values()).sort((a, b) =>
      b.latestMissedAt.localeCompare(a.latestMissedAt),
    );
  });

  async function groupAction(
    group: PendingGroup,
    action: "fire-once" | "fire-all" | "dismiss-all",
  ) {
    const key = groupKey(group.workspaceId, group.signalId);
    actingOnGroup = new Set([...actingOnGroup, key]);
    openMenuFor = null;
    try {
      const res = await fetch("/api/daemon/api/events/group", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: group.workspaceId,
          signalId: group.signalId,
          action,
        }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["workspace-events", "schedule.missed"] });
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
    } finally {
      actingOnGroup = new Set([...actingOnGroup].filter((k) => k !== key));
    }
  }

  // Close the dropdown when clicking outside.
  $effect(() => {
    if (!openMenuFor) return;
    const onDocClick = () => {
      openMenuFor = null;
    };
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  });

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

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  type Tab = "active" | "missed";
  type MissedSubTab = "active" | "history";
  let activeTab = $state<Tab>("active");
  let missedSubTab = $state<MissedSubTab>("active");

  const pendingEvents = $derived(events.filter((e) => e.status === "pending"));
  const historyEvents = $derived(events.filter((e) => e.status !== "pending"));
  const activeTimers = $derived(timers.filter((t) => !t.paused));

  // Bias toward Missed → Active sub-tab when there are pending manual
  // events. Coalesce/catchup auto-fire and land in History — they
  // don't pull attention.
  $effect(() => {
    if (pendingEvents.length > 0) {
      activeTab = "missed";
      missedSubTab = "active";
    }
  });
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
        <div class="tab-bar" role="tablist">
          <button
            class="tab"
            class:tab--active={activeTab === "active"}
            role="tab"
            aria-selected={activeTab === "active"}
            onclick={() => (activeTab = "active")}
          >
            Active <span class="tab-count">{activeTimers.length}</span>
          </button>
          <button
            class="tab"
            class:tab--active={activeTab === "missed"}
            role="tab"
            aria-selected={activeTab === "missed"}
            onclick={() => (activeTab = "missed")}
          >
            Missed
            {#if pendingEvents.length > 0}
              <span class="tab-count tab-count--pending">{pendingEvents.length}</span>
            {:else if historyEvents.length > 0}
              <span class="tab-count">{historyEvents.length}</span>
            {/if}
          </button>
        </div>

        {#if activeTab === "active"}
        <section class="section">
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

        {#if activeTab === "missed"}
        <section class="section">
          <div class="sub-tab-bar" role="tablist">
            <button
              class="sub-tab"
              class:sub-tab--active={missedSubTab === "active"}
              role="tab"
              aria-selected={missedSubTab === "active"}
              onclick={() => (missedSubTab = "active")}
            >
              Active <span class="sub-tab-count">{pendingEvents.length}</span>
            </button>
            <button
              class="sub-tab"
              class:sub-tab--active={missedSubTab === "history"}
              role="tab"
              aria-selected={missedSubTab === "history"}
              onclick={() => (missedSubTab = "history")}
            >
              History <span class="sub-tab-count">{historyEvents.length}</span>
            </button>
          </div>

          {#if missedSubTab === "active"}
            {#if pendingGroups.length === 0}
              <div class="empty-state">
                <p>No pending missed schedules.</p>
                <span class="empty-hint">
                  Pending entries appear here when an <code>onMissed: manual</code> cron
                  is missed. Auto-fired (<code>coalesce</code>, <code>catchup</code>) entries
                  go straight to History.
                </span>
              </div>
            {:else}
              <div class="signal-list">
                {#each pendingGroups as group (groupKey(group.workspaceId, group.signalId))}
                  {@const key = groupKey(group.workspaceId, group.signalId)}
                  {@const busy = actingOnGroup.has(key)}
                  {@const menuOpen = openMenuFor === key}
                  <div class="signal-row event-row">
                    <a class="row-main" href="/platform/{group.workspaceId}/signal/{group.signalId}">
                      <span class="signal-id">
                        {group.signalId}
                        <span class="badge badge-event badge-pending">
                          manual · pending{group.count > 1 ? ` · ${group.count} missed` : ""}
                        </span>
                      </span>
                      <span class="signal-meta">
                        <span class="ws-name">{group.workspaceId}</span>
                        <span class="sep">·</span>
                        <span class="cron-human">{humanizeCron(group.schedule, group.timezone)}</span>
                        <span class="sep">·</span>
                        <span class="event-time">
                          {#if group.count > 1}
                            oldest missed {formatRelative(group.earliestMissedAt)}
                          {:else}
                            missed {formatRelative(group.latestMissedAt)}
                          {/if}
                        </span>
                      </span>
                    </a>
                    <div class="row-right">
                      <div class="dropdown-btn">
                        <button
                          class="action-btn action-resume dropdown-btn__trigger"
                          disabled={busy}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          onclick={(e) => {
                            e.stopPropagation();
                            // Single missed slot → no choice to make,
                            // fire on click. Multiple → show menu.
                            if (group.count === 1) {
                              groupAction(group, "fire-once");
                            } else {
                              openMenuFor = menuOpen ? null : key;
                            }
                          }}
                        >
                          {busy ? "…" : "Trigger"}
                          {#if group.count > 1}
                            <span class="dropdown-btn__chevron" aria-hidden="true">
                              <IconSmall.ChevronDown />
                            </span>
                          {/if}
                        </button>
                        {#if menuOpen && group.count > 1}
                          <div class="dropdown-btn__menu" role="menu">
                            <button
                              class="dropdown-btn__menu-item"
                              role="menuitem"
                              onclick={(e) => {
                                e.stopPropagation();
                                groupAction(group, "fire-once");
                              }}
                            >
                              Trigger One
                            </button>
                            <button
                              class="dropdown-btn__menu-item"
                              role="menuitem"
                              onclick={(e) => {
                                e.stopPropagation();
                                groupAction(group, "fire-all");
                              }}
                            >
                              Trigger All ({group.count})
                            </button>
                          </div>
                        {/if}
                      </div>
                      <button
                        class="action-btn"
                        disabled={busy}
                        onclick={() => groupAction(group, "dismiss-all")}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {:else}
            {#if historyEvents.length === 0}
              <div class="empty-state">
                <p>No missed-schedule history.</p>
                <span class="empty-hint">
                  Auto-fired and operator-actioned entries land here. Window: 30 days.
                </span>
              </div>
            {:else}
              <div class="signal-list">
                {#each historyEvents as event (eventKey(event))}
                  <div class="signal-row event-row event-row--history">
                    <a class="row-main" href="/platform/{event.workspaceId}/signal/{event.signalId}">
                      <span class="signal-id">
                        {event.signalId}
                        <span class="badge badge-event badge-history">
                          {event.policy}{event.policy === "coalesce" && event.missedCount > 1
                            ? ` ×${event.missedCount}`
                            : ""}
                          {#if event.status === "fired"}· fired{:else if event.status === "dismissed"}· dismissed{:else}· auto-fired{/if}
                        </span>
                      </span>
                      <span class="signal-meta">
                        <span class="ws-name">{event.workspaceId}</span>
                        <span class="sep">·</span>
                        <span class="cron-human">{humanizeCron(event.schedule, event.timezone)}</span>
                        <span class="sep">·</span>
                        <span class="event-time">missed {formatRelative(event.scheduledAt)}</span>
                        {#if event.actionedAt}
                          <span class="sep">·</span>
                          <span class="event-time">
                            {event.status === "dismissed" ? "dismissed" : "fired"} {formatRelative(event.actionedAt)}
                          </span>
                        {:else if event.status === "auto"}
                          <span class="sep">·</span>
                          <span class="event-time">fired {formatRelative(event.firedAt)}</span>
                        {/if}
                      </span>
                    </a>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </section>
        {/if}
      {/if}
    </PageLayout.Content>
    <PageLayout.Sidebar>
      {#if activeTab === "active"}
        <p class="subtitle">All cron triggers across every space</p>
      {:else}
        <p class="subtitle">Cron firings the daemon was down for.</p>
        <p class="subtitle subtle">
          <strong>Active</strong>: pending <code>onMissed: manual</code> events waiting on
          your action.
        </p>
        <p class="subtitle subtle">
          <strong>History</strong>: fired / dismissed manual events, plus all auto-fired
          (<code>coalesce</code>, <code>catchup</code>) entries within the 30-day window.
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

  /* ── Tabs ────────────────────────────────────────────────────────── */

  .tab-bar {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    margin-block-end: var(--size-3);
  }

  .tab {
    align-items: center;
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    margin-block-end: -1px;
    padding: var(--size-1-5) var(--size-3);
    transition:
      color 120ms ease,
      border-color 120ms ease;
  }

  .tab:hover:not(.tab--active) {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
  }

  .tab--active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }

  .tab-count {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    line-height: 1;
    padding: 2px 6px;
  }

  .tab-count--pending {
    background-color: color-mix(in srgb, var(--color-accent, #1f6feb), transparent 80%);
    color: var(--color-accent, #1f6feb);
  }

  /* ── Sub-tabs (Active / History inside Missed) ───────────────────── */
  /* Same underlined-tab look as the parent .tab-bar so the visual
     hierarchy reads as "tabs all the way down" instead of mixing
     pill toggles with underlined tabs. Slightly smaller font + less
     padding to subordinate them to the parent tabs. */

  .sub-tab-bar {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    margin-block-end: var(--size-3);
  }

  .sub-tab {
    align-items: center;
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    margin-block-end: -1px;
    padding: var(--size-1) var(--size-3);
    transition:
      color 120ms ease,
      border-color 120ms ease;
  }

  .sub-tab:hover:not(.sub-tab--active) {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
  }

  .sub-tab--active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }

  .sub-tab-count {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: 0.7em;
    font-weight: var(--font-weight-6);
    line-height: 1;
    padding: 2px 6px;
  }

  /* ── Dropdown button (Trigger ▾ → Trigger One / Trigger All) ─────── */
  /* Single button with an inline chevron — click anywhere on the
     button opens a menu when count > 1, fires directly when count == 1
     (no choice to surface). Mirrors the Mews "Pay invoice ▾" pattern. */

  .dropdown-btn {
    display: inline-flex;
    position: relative;
  }

  .dropdown-btn__trigger {
    align-items: center;
    display: inline-flex;
    gap: var(--size-1);
  }

  .dropdown-btn__chevron {
    align-items: center;
    color: color-mix(in srgb, currentcolor, transparent 25%);
    display: inline-flex;
    margin-inline-start: -2px; /* tighten gap; the icon has its own padding */
  }

  .dropdown-btn__menu {
    background: var(--color-surface-1, white);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--color-text), transparent 88%);
    inset-block-start: calc(100% + 4px);
    inset-inline-end: 0;
    min-inline-size: 12rem;
    padding: var(--size-1);
    position: absolute;
    z-index: 10;
  }

  .dropdown-btn__menu-item {
    background: none;
    border: none;
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    display: block;
    font-size: var(--font-size-1);
    inline-size: 100%;
    padding: var(--size-1-5) var(--size-2);
    text-align: start;
  }

  .dropdown-btn__menu-item:hover {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
  }

  /* ── History row dimming + history badge ─────────────────────────── */

  .event-row--history {
    opacity: 0.7;
  }

  .event-row--history:hover {
    opacity: 1;
  }

  .badge-history {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
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
