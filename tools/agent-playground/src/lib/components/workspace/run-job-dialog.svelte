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

  let selectedSignalId = $state("");
  let formData = $state<Record<string, unknown>>({});

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
    selectedSignalId = "";
    formData = {};
    error = null;
  }

  function handleSignalChange(signalId: string) {
    selectedSignalId = signalId;
    formData = {};
    error = null;
  }

  async function handleSubmit(open: { set: (v: boolean) => void }) {
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

    // Use `?nowait=true` so the inbound HTTP request returns 202 as soon as
    // the signal is published to JetStream. The cascade runs decoupled from
    // this browser tab's lifetime — closing the modal, navigating away, or
    // refreshing won't abort the spawned session. The sync path (no nowait)
    // held the fetch open for the full cascade and cancelled the run on any
    // navigation; long jobs (minutes-plus) always lost that race.
    //
    // Direct fetch instead of the typed RPC client: the daemon route has no
    // `zValidator("query")`, so the Hono RPC input type doesn't expose a
    // `query` field. Adding one upstream would force every other caller
    // (CLI, MCP server, workspace-chat job tools, the platform client) to
    // pass `query: {}` boilerplate — not worth the churn for a single
    // optional flag.
    //
    // Auto-navigation: nowait's response doesn't carry a sessionId (the
    // consumer assigns one when it picks up the message). To still land the
    // user on the running session view, we record `since` before the POST
    // and then poll `/api/sessions?workspaceId=…` for a session that
    // started after that timestamp. Give up silently after a few seconds
    // — at that point the cascade may have crashed pre-session-creation
    // and there's nothing to navigate to.
    const since = Date.now();
    open.set(false);
    resetForm();

    const url = `${PROXY_BASE}/api/workspaces/${encodeURIComponent(
      workspaceId,
    )}/signals/${encodeURIComponent(signalId)}?nowait=true`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    })
      .then(async (res) => {
        if (!res.ok) {
          console.error("Trigger failed:", res.status);
          return;
        }
        // Poll for the spawned session and navigate when it appears.
        const sessionId = await findSpawnedSessionId(workspaceId, since);
        if (sessionId) {
          goto(`/platform/${workspaceId}/sessions/${sessionId}`);
        }
      })
      .catch((err) => {
        console.error("Failed to trigger signal:", err);
      });
  }

  /**
   * Poll the same endpoint that powers the Recent Runs panel
   * (`recent-sessions.svelte` → `sessionQueries.list`) until a session for
   * this workspace that started after `since` shows up. The list is
   * returned newest-first; a match on `startedAt >= since` is the run we
   * just triggered.
   *
   * Total budget ~6s at 400ms intervals — enough for the consumer to pick
   * up the JetStream message and instantiate the FSM (~50–500ms in dev,
   * up to 2s under load) without leaving the user staring at the jobs
   * page indefinitely if something upstream silently dropped the message.
   */
  async function findSpawnedSessionId(
    workspaceId: string,
    since: number,
  ): Promise<string | null> {
    const intervalMs = 400;
    const maxAttempts = 15;
    const client = getDaemonClient();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await client.sessions.index.$get({ query: { workspaceId } });
        if (res.ok) {
          const data = await res.json();
          const match = data.sessions?.find((s) => {
            const startedAt = s.startedAt ? Date.parse(s.startedAt) : Number.NaN;
            return Number.isFinite(startedAt) && startedAt >= since;
          });
          if (match?.sessionId) return match.sessionId;
        }
      } catch (err) {
        console.warn("Session poll failed:", err);
      }
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
            <Dialog.Button type="submit" closeOnClick={false}>
              Run
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
