<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import {
    buildCron,
    normalizeInterval,
    normalizeTime,
    parseCron,
    type Interval,
    type ScheduleState,
  } from "./cron";
  import { frequencyLabel } from "./schedule-label";
  import {
    buildTimezoneGroups,
    formatCurrentTime,
    formatTimezone,
    formatTimezoneCity,
    formatUtcOffset,
  } from "./timezone";

  interface Signal {
    description: string;
    title?: string;
    provider: string;
    config?: Record<string, unknown>;
  }

  let { signal, workspaceId, signalId }: { signal: Signal; workspaceId: string; signalId: string } =
    $props();

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function initSchedule(): ScheduleState {
    if (signal.provider === "schedule" && signal.config?.schedule) {
      const parsed = parseCron(String(signal.config.schedule));
      if (signal.config?.timezone) {
        parsed.timezone = String(signal.config.timezone);
      }
      return parsed;
    }
    return {
      mode: "manual",
      interval: "daily",
      days: [],
      time: "9:00",
      period: "AM",
      timezone: browserTimezone,
    };
  }

  const initial = initSchedule();
  let sched: ScheduleState = $state(structuredClone(initial));
  let prevSched: ScheduleState = $state(structuredClone(initial));
  let stashedSchedule: ScheduleState | null = $state(null);

  const timezoneGroups = buildTimezoneGroups(browserTimezone);
  const suggestedZones = new Set(timezoneGroups[0]?.zones ?? []);

  // -- Persistence ------------------------------------------------------------

  async function persist(modeSwitch = false) {
    const configClient = client.workspaceConfig(workspaceId);
    let result: { ok: boolean; error?: unknown };

    if (modeSwitch || sched.mode === "manual") {
      // Mode switch or manual mode → PUT with full signal (provider may change)
      let payload: Record<string, unknown>;
      if (sched.mode === "manual") {
        payload = { ...signal, provider: "http", config: { path: `/webhooks/${signalId}` } };
      } else {
        const cron = buildCron(sched);
        payload = {
          ...signal,
          provider: "schedule",
          config: { schedule: cron, timezone: sched.timezone },
        };
      }
      result = await parseResult(
        configClient.signals[":signalId"].$put({ param: { signalId }, json: payload }),
      );
    } else {
      // Schedule tweak → PATCH config only (preserves title, schema, description)
      const cron = buildCron(sched);
      result = await parseResult(
        configClient.signals[":signalId"].$patch({
          param: { signalId },
          json: { schedule: cron, timezone: sched.timezone },
        }),
      );
    }

    if (!result.ok) {
      sched = $state.snapshot(prevSched);
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      toast({ title: "Failed to update signal", description: message, error: true });
    }
  }

  function snapshot() {
    prevSched = $state.snapshot(sched);
  }

  // -- Mode switching ---------------------------------------------------------

  function selectManual() {
    if (sched.mode === "manual") return;
    snapshot();
    stashedSchedule = $state.snapshot(sched);
    sched.mode = "manual";
    persist(true);
  }

  /** Ensure we're in schedule mode. Returns true if a mode switch happened. */
  function ensureScheduleMode(): boolean {
    if (sched.mode === "schedule") return false;
    if (stashedSchedule) {
      Object.assign(sched, stashedSchedule);
      sched.mode = "schedule";
      stashedSchedule = null;
    } else {
      sched.mode = "schedule";
      sched.interval = "weekly";
      sched.days = ["Monday"];
      sched.time = "9:00";
      sched.period = "AM";
      sched.timezone = browserTimezone;
    }
    return true;
  }

  // -- Frequency selection ----------------------------------------------------

  function selectInterval(interval: Interval) {
    snapshot();
    const switched = ensureScheduleMode();

    sched.interval = interval;

    if (interval === "hourly") {
      sched.days = [];
      sched.time = "";
      sched.period = "AM";
    } else if (interval === "daily") {
      sched.days = [];
      if (!sched.time || sched.period === "Hours") {
        sched.time = "9:00";
        sched.period = "AM";
      }
    } else if (interval === "weekly") {
      if (sched.days.length === 0) {
        sched.days = ["Monday"];
      }
      if (!sched.time || sched.period === "Hours") {
        sched.time = "9:00";
        sched.period = "AM";
      }
    } else if (interval === "interval") {
      sched.days = [];
      sched.time = sched.period === "Hours" ? sched.time : "2";
      sched.period = "Hours";
    }

    persist(switched);
  }

  // -- Day selection ----------------------------------------------------------

  function selectDay(day: string) {
    snapshot();

    const idx = sched.days.indexOf(day);
    if (idx >= 0) {
      if (sched.days.length > 1) {
        sched.days = sched.days.filter((d) => d !== day);
      }
    } else {
      sched.days = [...sched.days, day].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    }

    persist();
  }

  // -- Frequency dropdown close normalization ---------------------------------

  function handleFrequencyOpenChange({ next }: { curr: boolean; next: boolean }): boolean {
    if (!next && sched.interval === "weekly" && sched.days.length === 7) {
      sched.interval = "daily";
      sched.days = [];
      persist();
    }
    return next;
  }

  // -- Time input -------------------------------------------------------------

  function handleTimeFocus() {
    snapshot();
  }

  function handleTimeKeydown(e: KeyboardEvent) {
    if (sched.period === "Hours") {
      if (e.key.length === 1 && !/\d/.test(e.key)) {
        e.preventDefault();
      }
    } else {
      if (e.key.length === 1 && !/[\d:]/.test(e.key)) {
        e.preventDefault();
      }
    }
  }

  function handleTimeBlur() {
    if (sched.period === "Hours") {
      const normalized = normalizeInterval(sched.time);
      if (!normalized) {
        sched = $state.snapshot(prevSched);
        return;
      }
      sched.time = normalized;
    } else {
      const normalized = normalizeTime(sched.time, sched.period);
      if (!normalized) {
        sched = $state.snapshot(prevSched);
        return;
      }
      sched.time = normalized.time;
      sched.period = normalized.period;
    }

    persist();
  }

  // -- Period toggle ----------------------------------------------------------

  function togglePeriod() {
    snapshot();
    sched.period = sched.period === "AM" ? "PM" : "AM";
    persist();
  }

  // -- Timezone selection -----------------------------------------------------

  function selectTimezone(tz: string) {
    snapshot();
    sched.timezone = tz;
    persist();
  }

  // -- Visibility helpers -----------------------------------------------------

  const isSchedule = $derived(sched.mode === "schedule");
  const showDays = $derived(isSchedule && sched.interval === "weekly");
  const showTime = $derived(
    isSchedule && (sched.interval === "daily" || sched.interval === "weekly"),
  );
  const showInterval = $derived(isSchedule && sched.interval === "interval");
  const showTimezone = $derived(
    isSchedule && sched.interval !== "hourly" && sched.interval !== "interval",
  );
</script>

<div class="root">
  {#if signal.title}
    <p class="title">{signal.title}</p>
  {/if}
  <p class="description">{signal.description}</p>
  <div class="details">
    <!-- Frequency dropdown (includes manual mode) -->
    <DropdownMenu.Root onOpenChange={handleFrequencyOpenChange}>
      <DropdownMenu.Trigger>
        <span class="trigger">
          <span class="trigger-label">{frequencyLabel(sched)}</span>
          <IconSmall.CaretDown />
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Label>Signal Trigger</DropdownMenu.Label>
        <DropdownMenu.Item checked={sched.mode === "manual"} radio onclick={() => selectManual()}>
          Manually
        </DropdownMenu.Item>
        <DropdownMenu.Item
          checked={isSchedule && sched.interval === "interval"}
          radio
          onclick={() => selectInterval("interval")}
        >
          Interval
        </DropdownMenu.Item>

        <DropdownMenu.Item
          checked={isSchedule && sched.interval === "hourly"}
          radio
          onclick={() => selectInterval("hourly")}
        >
          Hourly
        </DropdownMenu.Item>
        <DropdownMenu.Item
          checked={isSchedule && sched.interval === "daily"}
          radio
          onclick={() => selectInterval("daily")}
        >
          Daily
        </DropdownMenu.Item>
        <DropdownMenu.Item
          checked={isSchedule && sched.interval === "weekly"}
          radio
          closeOnClick={false}
          onclick={() => selectInterval("weekly")}
        >
          Weekly
        </DropdownMenu.Item>

        {#if showDays}
          <DropdownMenu.Separator />
          <DropdownMenu.Label>Weekly on</DropdownMenu.Label>
          {#each DAYS as day (day)}
            <DropdownMenu.Item
              checked={sched.days.includes(day)}
              closeOnClick={false}
              onclick={() => selectDay(day)}
            >
              {day}
            </DropdownMenu.Item>
          {/each}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>

    {#if showTime}
      <span class="separator">at</span>

      <span class="time">
        <input
          type="text"
          class="input"
          bind:value={sched.time}
          onfocus={handleTimeFocus}
          onkeydown={handleTimeKeydown}
          onblur={handleTimeBlur}
        />
        <button type="button" class="period" onclick={togglePeriod}>{sched.period}</button>
      </span>
    {/if}

    {#if showInterval}
      <span class="separator">every</span>

      <span class="time interval-time">
        <input
          type="text"
          class="input interval-input"
          bind:value={sched.time}
          onfocus={handleTimeFocus}
          onkeydown={handleTimeKeydown}
          onblur={handleTimeBlur}
        />
      </span>

      <span class="separator">hours</span>
    {/if}

    {#if showTimezone}
      <span class="timezone">
        {formatTimezoneCity(sched.timezone)} ({formatUtcOffset(sched.timezone)})
        <!-- Timezone dropdown -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <span class="timezone-trigger">Change</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.List>
              {#each timezoneGroups as group (group.label)}
                <DropdownMenu.Label>{group.label}</DropdownMenu.Label>
                {#each group.zones as tz (tz)}
                  <DropdownMenu.Item
                    checked={sched.timezone === tz &&
                      (group.label === "Suggested" || !suggestedZones.has(tz))}
                    onclick={() => selectTimezone(tz)}
                  >
                    {formatTimezone(tz.split("/").slice(1).join("/"))}

                    {#snippet prepend()}
                      <span class="timezone-time">{formatCurrentTime(tz)}</span>
                    {/snippet}
                  </DropdownMenu.Item>
                {/each}
              {/each}
            </DropdownMenu.List>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </span>
    {/if}
  </div>
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
  }

  .title {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .description {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    line-height: 1.45;
    opacity: 0.7;
  }

  .details {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
    margin-block-start: var(--size-4);
  }

  .separator {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    opacity: 0.6;
  }

  .trigger {
    align-items: center;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    block-size: var(--size-6-5);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    max-inline-size: var(--size-64);
    padding-block: var(--size-1);
    padding-inline: var(--size-3);

    & :global(svg) {
      block-size: 14px;
      flex: none;
      inline-size: 14px;
      opacity: 0.5;
    }
  }

  .trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    align-items: center;
    background-color: var(--color-text);
    border-radius: var(--radius-3);
    block-size: var(--size-6-5);
    display: flex;
    flex: none;
    padding: var(--size-px);
    gap: 0;

    @media (prefers-color-scheme: dark) {
      background-color: var(--color-border-1);
    }

    .input {
      background-color: var(--color-surface-1);
      border-radius: calc(var(--radius-3) - var(--size-px));
      block-size: 100%;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      padding-block: var(--size-1);
      padding-inline: var(--size-3);
      inline-size: var(--size-16);

      &.interval-input {
        inline-size: var(--size-12);
        padding-inline-end: var(--size-1);
      }
    }

    .period {
      align-items: center;
      background: none;
      border: none;
      color: var(--color-surface-1);
      cursor: pointer;
      display: flex;
      font-size: var(--font-size-0);
      font-weight: var(--font-weight-7);
      flex: none;
      padding-inline: var(--size-1-5);

      @media (prefers-color-scheme: dark) {
        color: var(--color-text);
      }
    }
  }

  .timezone {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-1-5);
    padding-inline: var(--size-1-5) 0;
  }

  .timezone-trigger {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    text-decoration: underline;
  }

  .timezone-time {
    opacity: 0.6;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }
</style>
