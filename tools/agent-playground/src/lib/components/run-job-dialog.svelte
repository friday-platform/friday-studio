<!--
  Modal dialog for running a workspace job. Derives form fields from the
  trigger signal's JSON Schema, then fires the signal via the daemon.

  Uses the Melt UI Dialog from @atlas/ui — identical to the web-client pattern.

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
  import { getDaemonClient } from "$lib/daemon-client";
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
  let isRunning = $state(false);
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

    isRunning = true;
    error = null;

    try {
      const client = getDaemonClient();
      const res = await client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId },
        json: { payload },
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const hasErr = typeof body === "object" && body !== null && "error" in body;
        error = hasErr
          ? String((body as Record<string, unknown>).error)
          : `Trigger failed (${res.status})`;
        return;
      }

      const data = await res.json();
      isRunning = false;
      open.set(false);
      resetForm();
      if (data.sessionId) {
        goto(`/platform/${workspaceId}/sessions/${data.sessionId}`);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to trigger signal";
      isRunning = false;
    }
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
            <Dialog.Button type="submit" closeOnClick={false} disabled={isRunning}>
              {isRunning ? "Running..." : "Run"}
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
