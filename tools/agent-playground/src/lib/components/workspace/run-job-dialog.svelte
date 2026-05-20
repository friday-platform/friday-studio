<!--
  Modal dialog for running a workspace job. Derives form fields from the
  trigger signal's JSON Schema, then fires the signal via the daemon.

  Uses the Melt UI Dialog from @atlas/ui.

  @component
  @param {string} workspaceId - Active workspace ID
  @param {string} jobId - Job ID to run
  @param {string} jobTitle - Display title for the job
  @param {Record<string, { description: string; title?: string; schema?: Record<string, unknown> }>} signals - All workspace signals
  @param {{ signal: string }[]} triggers - Job trigger specs referencing signal IDs
-->
<script lang="ts">
  import { Button, Dialog } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { getDaemonClient, PROXY_BASE } from "$lib/daemon-client";
  import {
    getFieldRendering,
    humanizeFieldName,
    parseFieldDef,
    type FieldDef,
  } from "$lib/utils/field-helpers";

  type Signal = { description: string; title?: string; schema?: Record<string, unknown> };

  type Props = {
    workspaceId: string;
    jobId: string;
    jobTitle: string;
    signals: Record<string, Signal>;
    triggers: { signal: string }[];
  };

  let { workspaceId, jobId, jobTitle, signals, triggers }: Props = $props();

  let error = $state<string | null>(null);
  let submitting = $state(false);

  let selectedSignalId = $state("");
  let formData = $state<Record<string, unknown>>({});

  /**
   * Held in component scope so unmount cleanup and Cancel can abort an
   * in-flight trigger+poll cycle. Without it, a poll that outlives the
   * dialog would happily fire `goto()` on whatever page the user
   * navigated to next.
   */
  let pollController: AbortController | null = null;

  $effect(() => {
    return () => {
      pollController?.abort();
      pollController = null;
    };
  });

  const triggerSignals = $derived(
    triggers
      .filter((t) => t.signal in signals)
      .map((t) => ({ id: t.signal, signal: signals[t.signal] })),
  );

  const isMultiTrigger = $derived(triggerSignals.length > 1);

  const activeSignalId = $derived(
    isMultiTrigger ? selectedSignalId : (triggerSignals[0]?.id ?? ""),
  );

  const activeSignal = $derived(activeSignalId ? signals[activeSignalId] : undefined);

  const activeSchema = $derived(activeSignal?.schema);

  const schemaProperties = $derived.by((): [string, FieldDef][] => {
    const props = activeSchema?.["properties"];
    if (!props || typeof props !== "object") return [];
    return Object.entries(props).map(([k, v]) => [k, parseFieldDef(v)]);
  });

  const hasSchema = $derived(schemaProperties.length > 0);

  const requiredFields = $derived.by(() => {
    const req = activeSchema?.["required"];
    if (!Array.isArray(req)) return new Set<string>();
    return new Set(req.filter((v): v is string => typeof v === "string"));
  });

  function resetForm() {
    pollController?.abort();
    pollController = null;
    selectedSignalId = "";
    formData = {};
    error = null;
    submitting = false;
  }

  function handleSignalChange(signalId: string) {
    selectedSignalId = signalId;
    formData = {};
    error = null;
  }

  async function handleSubmit(open: { set: (v: boolean) => void }) {
    if (submitting) return;

    if (!activeSignalId) {
      error = "Please select a signal to trigger";
      return;
    }

    if (hasSchema) {
      for (const [field, fieldDef] of schemaProperties) {
        if (!requiredFields.has(field)) continue;
        const value = formData[field];
        if (value === undefined || value === "") {
          const label = fieldDef.title ?? humanizeFieldName(field);
          error = `Field "${label}" is required`;
          return;
        }
      }
    }

    const signalId = activeSignalId;
    const payload = hasSchema ? { ...formData } : undefined;

    error = null;
    submitting = true;

    // Use `?nowait=true` so the inbound HTTP request returns 202 as soon
    // as the signal is published to JetStream. The cascade runs decoupled
    // from this browser tab's lifetime — closing the modal, navigating
    // away, or refreshing won't abort the spawned session. The sync path
    // (no nowait) held the fetch open for the full cascade and cancelled
    // the run on any navigation; long jobs (minutes-plus) always lost
    // that race.
    //
    // Direct fetch instead of the typed RPC client: the daemon route has
    // no `zValidator("query")`, so the Hono RPC input type doesn't
    // expose a `query` field. Adding one upstream would force every
    // other caller (CLI, MCP server, workspace-chat job tools, the
    // platform client) to pass `query: {}` boilerplate — not worth the
    // churn for a single optional flag.
    //
    // Auto-navigation: nowait's 202 carries a `correlationId`. The
    // daemon threads it onto `SessionSummary.correlationId` (see
    // `SessionSummarySchema` in @atlas/core), and `GET /api/sessions`
    // accepts a `correlationId` filter. Poll the filter until our
    // session appears, then navigate — deterministic match, no race
    // even when two tabs fire the same job at once (each gets its
    // own correlationId server-side).
    //
    // Modal stays open showing "Starting…" until we either land on
    // the spawned session view or the poll budget runs out — closing
    // on click before the session existed gave the user "nothing
    // happened" for up to half a second on the happy path.
    pollController?.abort();
    const controller = new AbortController();
    pollController = controller;
    const { signal } = controller;

    try {
      const url = `${PROXY_BASE}/api/workspaces/${encodeURIComponent(
        workspaceId,
      )}/signals/${encodeURIComponent(signalId)}?nowait=true`;
      const triggerRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
        signal,
      });
      if (!triggerRes.ok) {
        error = `Trigger failed (HTTP ${triggerRes.status})`;
        submitting = false;
        return;
      }
      const triggerBody = (await triggerRes.json()) as { correlationId?: string };
      const correlationId = triggerBody.correlationId;
      if (!correlationId) {
        error = "Trigger accepted but the daemon didn't return a correlation id.";
        submitting = false;
        return;
      }

      const sessionId = await findSessionByCorrelationId(workspaceId, correlationId, signal);
      if (signal.aborted) return;

      if (sessionId) {
        // Route change unmounts the dialog; the $effect cleanup aborts
        // the controller automatically, so no separate teardown here.
        open.set(false);
        resetForm();
        goto(`/platform/${workspaceId}/sessions/${sessionId}`);
      } else {
        error = "Couldn't find the spawned session — check Recent Runs.";
        submitting = false;
      }
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") return;
      console.error("Failed to trigger signal:", err);
      error = "Failed to trigger signal.";
      submitting = false;
    }
  }

  /**
   * Poll `GET /api/sessions?workspaceId=…&correlationId=…` until the
   * cascade consumer has spawned the session and tagged it with our
   * correlationId. Deterministic match — correlationId is unique per
   * signal trigger, so we cannot race with another tab or with cron.
   *
   * Budget: first poll fires immediately, then 150ms cadence for the
   * first 5 attempts (user is staring at "Starting…"; tighten the
   * loop), then 400ms for the remaining 12 attempts (~5s tail). Total
   * ~5.5s before we give up and surface an inline error.
   */
  async function findSessionByCorrelationId(
    workspaceId: string,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const fastInterval = 150;
    const fastAttempts = 5;
    const slowInterval = 400;
    const slowAttempts = 12;
    const totalAttempts = fastAttempts + slowAttempts;
    const client = getDaemonClient();
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (signal.aborted) return null;
      try {
        const res = await client.sessions.index.$get(
          { query: { workspaceId, correlationId } },
          { init: { signal } },
        );
        if (res.ok) {
          const data = await res.json();
          const match = data.sessions[0];
          if (match?.sessionId) return match.sessionId;
        }
      } catch (err) {
        if ((err as Error | undefined)?.name === "AbortError") return null;
        console.warn("Session poll failed:", err);
      }
      if (signal.aborted) return null;
      const intervalMs = attempt < fastAttempts ? fastInterval : slowInterval;
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }
</script>

<Dialog.Root
  onOpenChange={({ next }) => {
    if (!next) resetForm();
    return next;
  }}
>
  {#snippet children(open)}
    <Dialog.Trigger>
      <Button size="small" variant="primary" disabled={triggerSignals.length === 0}>Run</Button>
    </Dialog.Trigger>

    <Dialog.Content size="large">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Run {jobTitle}?</Dialog.Title>
      {/snippet}

      {#snippet footer()}
        <form
          class="form"
          onsubmit={(e) => {
            e.preventDefault();
            handleSubmit(open);
          }}
        >
          {#if !isMultiTrigger && !hasSchema}
            <p class="confirmation">This will trigger the job immediately.</p>
          {/if}

          {#if isMultiTrigger}
            <fieldset class="field">
              <legend class="legend">Select trigger</legend>
              {#each triggerSignals as { id, signal } (id)}
                <label class="radio-label">
                  <input
                    type="radio"
                    name="signal"
                    value={id}
                    checked={selectedSignalId === id}
                    onchange={() => handleSignalChange(id)}
                  />
                  <span>{signal.title ?? signal.description}</span>
                </label>
              {/each}
            </fieldset>
          {/if}

          {#if hasSchema}
            {#each schemaProperties as [fieldName, fieldDef] (fieldName)}
              {@const fieldId = `field-${jobId}-${fieldName}`}
              {@const isRequired = requiredFields.has(fieldName)}
              {@const rendering = getFieldRendering(fieldDef)}
              {@const fieldLabel = fieldDef.title ?? humanizeFieldName(fieldName)}
              <div class="field">
                {#if rendering !== "boolean"}
                  <label for={fieldId}>
                    {fieldLabel}
                    {#if isRequired}<span class="required">*</span>{/if}
                  </label>
                {/if}
                {#if fieldDef.description}
                  <span class="field-description">{fieldDef.description}</span>
                {/if}
                {#if rendering === "boolean"}
                  <label class="checkbox-label">
                    <input
                      id={fieldId}
                      type="checkbox"
                      checked={formData[fieldName] === true}
                      onchange={(e) => {
                        formData[fieldName] = e.currentTarget.checked;
                      }}
                    />
                    <span>{fieldLabel}</span>
                  </label>
                {:else if rendering === "number"}
                  <input
                    id={fieldId}
                    type="number"
                    value={formData[fieldName] ?? ""}
                    placeholder={`Enter ${fieldLabel.toLowerCase()}`}
                    oninput={(e) => {
                      const val = e.currentTarget.value;
                      formData[fieldName] = val === "" ? undefined : Number(val);
                    }}
                    required={isRequired}
                    step={fieldDef.type === "integer" ? "1" : "any"}
                  />
                {:else}
                  <input
                    id={fieldId}
                    type="text"
                    value={formData[fieldName] ?? ""}
                    placeholder={`Enter ${fieldLabel.toLowerCase()}`}
                    oninput={(e) => {
                      formData[fieldName] = e.currentTarget.value;
                    }}
                    required={isRequired}
                  />
                {/if}
              </div>
            {/each}
          {/if}

          {#if error}
            <div class="error">{error}</div>
          {/if}

          <div class="buttons">
            <Dialog.Button type="submit" closeOnClick={false} disabled={submitting}>
              {submitting ? "Starting…" : "Run"}
            </Dialog.Button>
            <Dialog.Cancel onclick={resetForm}>Cancel</Dialog.Cancel>
          </div>
        </form>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
    max-inline-size: var(--size-96);
  }

  .field {
    border: none;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: 0;
    text-align: start;
  }

  label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .legend {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin-block-end: var(--size-1);
    opacity: 0.7;
  }

  .required {
    color: var(--color-red);
  }

  .field-description {
    color: var(--color-text);
    font-size: var(--font-size-2);
    opacity: 0.5;
    overflow-wrap: break-word;
  }

  input[type="text"],
  input[type="number"] {
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding-inline: var(--size-3);
    transition: all 200ms ease;
  }

  input[type="text"]:focus,
  input[type="number"]:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  input[type="text"]::placeholder,
  input[type="number"]::placeholder {
    color: color-mix(in oklch, var(--color-text) 50%, transparent);
  }

  .radio-label,
  .checkbox-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-4);
    gap: var(--size-2);
    opacity: 1;
  }

  .confirmation {
    color: var(--color-text);
    font-size: var(--font-size-3);
    opacity: 0.7;
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border: var(--size-px) solid var(--color-red);
    border-radius: var(--radius-2);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }

  .buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>
