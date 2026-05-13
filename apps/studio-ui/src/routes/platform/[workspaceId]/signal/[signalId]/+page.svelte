<script lang="ts">
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { Button, JsonHighlight } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { z } from "zod";
  import { page } from "$app/state";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { getDaemonClient } from "$lib/daemon-client";
  import { workspaceQueries } from "$lib/queries";

  const client = getDaemonClient();
  const queryClient = useQueryClient();

  const workspaceId = $derived(page.params.workspaceId);
  const signalId = $derived(page.params.signalId);

  const signalQuery = createQuery(() => ({
    ...workspaceQueries.signal(workspaceId, signalId),
    enabled: Boolean(workspaceId && signalId),
  }));

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));

  const TimerSchema = z.object({
    workspaceId: z.string(),
    signalId: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    nextExecution: z.string(),
    lastExecution: z.string().nullable(),
    paused: z.boolean(),
  });
  const TimersResponseSchema = z.object({ timers: z.array(TimerSchema) });

  const timersQuery = createQuery(() => ({
    queryKey: ["cron", "timers"],
    queryFn: async () => {
      const res = await client.cron.timers.$get();
      if (!res.ok) throw new Error(`Failed to fetch timers: ${res.status}`);
      return TimersResponseSchema.parse(await res.json());
    },
    refetchInterval: 30_000,
  }));

  const signal = $derived(signalQuery.data ?? null);

  // provider lives at the top level of the signal response, not inside config
  const provider = $derived.by(() => {
    if (!signal) return "unknown";
    const s = signal as Record<string, unknown>;
    return typeof s.provider === "string" ? s.provider : "unknown";
  });

  const config = $derived.by((): Record<string, unknown> | null => {
    if (!signal) return null;
    const s = signal as Record<string, unknown>;
    const c = s.config;
    if (typeof c !== "object" || c === null) return null;
    const entries = Object.entries(c as Record<string, unknown>);
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  });

  const schema = $derived(signal && "schema" in signal ? signal.schema : null);

  const description = $derived.by(() => {
    if (!signal) return null;
    const s = signal as Record<string, unknown>;
    return typeof s.description === "string" ? s.description : null;
  });

  const title = $derived.by(() => {
    if (!signal) return null;
    const s = signal as Record<string, unknown>;
    return typeof s.title === "string" ? s.title : null;
  });

  /** Cron timer entry for this signal, if it's a schedule provider. */
  const cronTimer = $derived(
    timersQuery.data?.timers.find(
      (t) => t.workspaceId === workspaceId && t.signalId === signalId,
    ) ?? null,
  );

  /** Jobs that list this signal as a trigger. */
  const triggeringJobs = $derived.by((): { id: string; title: string }[] => {
    const data = configQuery.data;
    if (!data?.config.jobs) return [];
    const result: { id: string; title: string }[] = [];
    for (const [jobId, job] of Object.entries(data.config.jobs)) {
      if (typeof job !== "object" || job === null) continue;
      const rec = job as Record<string, unknown>;
      const triggers = Array.isArray(rec.triggers) ? rec.triggers : [];
      const usesSignal = triggers.some(
        (t) => typeof t === "object" && t !== null && "signal" in t && t.signal === signalId,
      );
      if (usesSignal) {
        const jobTitle = typeof rec.title === "string" ? rec.title : humanizeStepName(jobId);
        result.push({ id: jobId, title: jobTitle });
      }
    }
    return result;
  });

  const PROVIDER_LABELS: Record<string, string> = {
    http: "HTTP",
    schedule: "Schedule",
    "fs-watch": "File Watch",
    system: "System",
  };

  const PROVIDER_VARIANTS: Record<
    string,
    "info" | "accent" | "success" | "neutral" | "warning"
  > = {
    http: "info",
    schedule: "accent",
    "fs-watch": "success",
    system: "neutral",
  };

  function providerLabel(p: string): string {
    return PROVIDER_LABELS[p] ?? p;
  }

  function providerVariant(p: string): "info" | "accent" | "success" | "neutral" | "warning" {
    return PROVIDER_VARIANTS[p] ?? "neutral";
  }

  function formatJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  function formatValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function formatRelative(iso: string | null): string {
    if (!iso) return "never";
    const date = new Date(iso);
    const diff = date.getTime() - Date.now();
    const abs = Math.abs(diff);
    const past = diff < 0;
    if (abs < 60_000) return past ? "just now" : "< 1 min";
    if (abs < 3_600_000) {
      const mins = Math.round(abs / 60_000);
      return past ? `${mins}m ago` : `in ${mins}m`;
    }
    const hrs = Math.round(abs / 3_600_000);
    return past ? `${hrs}h ago` : `in ${hrs}h`;
  }

  // ── Trigger ────────────────────────────────────────────────────────

  let triggering = $state(false);
  let triggerError = $state<string | null>(null);
  let triggerSuccess = $state(false);

  $effect(() => {
    void signalId;
    triggerError = null;
    triggerSuccess = false;
  });

  async function handleTrigger() {
    triggering = true;
    triggerError = null;
    triggerSuccess = false;
    try {
      const res = await client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId },
        json: {},
      });
      if (!res.ok) {
        triggerError = `Trigger failed: ${await res.text()}`;
        return;
      }
      triggerSuccess = true;
      setTimeout(() => {
        triggerSuccess = false;
      }, 3000);
    } catch (e) {
      triggerError = e instanceof Error ? e.message : "Trigger failed";
    } finally {
      triggering = false;
    }
  }

  // ── Pause / Resume ─────────────────────────────────────────────────

  let toggling = $state(false);

  async function togglePause() {
    if (!cronTimer) return;
    toggling = true;
    try {
      const action = cronTimer.paused ? "resume" : "pause";
      const res = await fetch(
        `/api/daemon/api/cron/timers/${encodeURIComponent(workspaceId)}/${encodeURIComponent(signalId)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["cron", "timers"] });
    } catch (e) {
      console.error("Failed to toggle schedule:", e);
    } finally {
      toggling = false;
    }
  }
</script>

<div class="signal-detail">
  <div class="main">
    <div class="top-bar">
      <WorkspaceBreadcrumb {workspaceId} />
    </div>

    {#if signalQuery.isPending}
      <div class="loading">Loading signal…</div>
    {:else if signalQuery.isError}
      <div class="error-state">
        <p>Failed to load signal</p>
        <Button size="small" variant="secondary" onclick={() => signalQuery.refetch()}>
          Retry
        </Button>
      </div>
    {:else}
      <header class="signal-header">
        <div class="title-row">
          <h1>{title ?? signalId}</h1>
          <InlineBadge variant={providerVariant(provider)}>
            {providerLabel(provider)}
          </InlineBadge>
        </div>
        {#if title}
          <p class="signal-id-sub">{signalId}</p>
        {/if}
        {#if description}
          <p class="signal-description">{description}</p>
        {/if}
      </header>

      {#if config && Object.keys(config).length > 0}
        <section class="detail-section">
          <h2 class="section-label">Configuration</h2>
          <dl class="field-list">
            {#each Object.entries(config) as [key, value] (key)}
              <div class="field-row">
                <dt>{key}</dt>
                <dd class="mono">{formatValue(value)}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/if}

      {#if schema}
        <section class="detail-section">
          <h2 class="section-label">Input Schema</h2>
          <div class="schema-block">
            <JsonHighlight code={formatJson(schema)} />
          </div>
        </section>
      {/if}

      {#if triggeringJobs.length > 0}
        <section class="detail-section">
          <h2 class="section-label">Triggers</h2>
          <ul class="job-list">
            {#each triggeringJobs as job (job.id)}
              <li class="job-item">
                <a href="/platform/{workspaceId}/jobs/{job.id}" class="job-link">
                  {job.title}
                </a>
                <span class="job-id">{job.id}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}
  </div>

  <aside class="detail-sidebar">
    <div class="sidebar-section">
      <h3>Actions</h3>
      <div class="action-row">
        <Button size="small" onclick={handleTrigger} disabled={triggering}>
          {triggering ? "Triggering…" : "Trigger Now"}
        </Button>
        {#if cronTimer}
          <Button
            size="small"
            variant="secondary"
            onclick={togglePause}
            disabled={toggling}
          >
            {toggling ? "…" : cronTimer.paused ? "Resume" : "Pause"}
          </Button>
        {/if}
      </div>
      {#if triggerSuccess}
        <p class="trigger-success">Signal triggered</p>
      {/if}
      {#if triggerError}
        <p class="trigger-error">{triggerError}</p>
      {/if}
    </div>

    {#if cronTimer}
      <div class="sidebar-section">
        <h3>Schedule</h3>
        <dl class="field-list">
          <div class="field-row">
            <dt>Status</dt>
            <dd>
              <span class="badge" class:badge-paused={cronTimer.paused} class:badge-active={!cronTimer.paused}>
                {cronTimer.paused ? "Paused" : "Active"}
              </span>
            </dd>
          </div>
          {#if !cronTimer.paused}
            <div class="field-row">
              <dt>Next run</dt>
              <dd>{formatRelative(cronTimer.nextExecution)}</dd>
            </div>
          {/if}
          {#if cronTimer.lastExecution}
            <div class="field-row">
              <dt>Last run</dt>
              <dd>{formatRelative(cronTimer.lastExecution)}</dd>
            </div>
          {/if}
        </dl>
      </div>
    {/if}

    <div class="sidebar-section">
      <h3>Details</h3>
      <dl class="field-list">
        <div class="field-row">
          <dt>ID</dt>
          <dd class="mono">{signalId}</dd>
        </div>
        <div class="field-row">
          <dt>Provider</dt>
          <dd>{providerLabel(provider)}</dd>
        </div>
        <div class="field-row">
          <dt>Workspace</dt>
          <dd class="mono">{workspaceId}</dd>
        </div>
      </dl>
    </div>
  </aside>
</div>

<style>
  .signal-detail {
    block-size: 100%;
    display: grid;
    grid-template-columns: 1fr var(--size-72);
    overflow: hidden;
  }

  /* ── Main pane ───────────────────────────────────────────────────── */

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    overflow: auto;
    padding: var(--size-8) var(--size-10);
    scrollbar-width: thin;
  }

  .top-bar {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .signal-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .title-row {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .title-row h1 {
    font-family: var(--font-mono);
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
  }

  .signal-id-sub {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-mono);
    font-size: var(--font-size-2);
  }

  .signal-description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    max-inline-size: 60ch;
  }

  /* ── Sections ────────────────────────────────────────────────────── */

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    margin: 0;
    text-transform: uppercase;
  }

  /* ── Field list (dl) ─────────────────────────────────────────────── */

  .field-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    margin: 0;
    padding: 0;
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);

    dt {
      color: var(--color-text);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    dd {
      color: color-mix(in srgb, var(--color-text), transparent 25%);
      font-size: var(--font-size-2);
      margin: 0;
    }
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--font-size-1) !important;
    word-break: break-all;
  }

  /* ── Schema block ────────────────────────────────────────────────── */

  .schema-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    max-block-size: 320px;
    overflow-y: auto;
    padding: var(--size-3);
    scrollbar-width: thin;
  }

  /* ── Job list ────────────────────────────────────────────────────── */

  .job-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .job-item {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .job-link {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, currentColor, transparent 60%);
      text-underline-offset: var(--size-0-5);
    }
  }

  .job-id {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }

  /* ── States ──────────────────────────────────────────────────────── */

  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-4);
    padding-block-start: var(--size-8);
  }

  .error-state {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      color: color-mix(in srgb, var(--color-text), transparent 25%);
      font-size: var(--font-size-4);
    }
  }

  /* ── Detail sidebar ──────────────────────────────────────────────── */

  .detail-sidebar {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    overflow: auto;
    padding: var(--size-8) var(--size-6);
    scrollbar-width: thin;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);

    h3 {
      color: color-mix(in srgb, var(--color-text), transparent 30%);
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      letter-spacing: var(--font-letterspacing-2);
      text-transform: uppercase;
    }
  }

  .action-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .badge {
    border-radius: var(--radius-round);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 2px var(--size-2);
  }

  .badge-active {
    background-color: color-mix(in srgb, var(--color-success), transparent 80%);
    color: var(--color-success);
  }

  .badge-paused {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .trigger-success {
    color: var(--color-success);
    font-size: var(--font-size-1);
  }

  .trigger-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }
</style>
