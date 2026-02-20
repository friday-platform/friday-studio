<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { stringifyError } from "@atlas/utils";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { Dialog } from "$lib/components/dialog";
  import { toast } from "$lib/components/notification/notification.svelte";
  import type { Snippet } from "svelte";
  import { z } from "zod";

  type Signal = {
    description: string;
    title?: string;
    provider: string;
    schema?: Record<string, unknown>;
  };

  type Job = {
    title?: string;
    description?: string;
    name?: string;
    triggers?: { signal: string; condition?: unknown }[];
  };

  type Props = {
    jobId: string;
    job: Job;
    signals: Record<string, Signal>;
    workspaceId: string;
    triggerContents: Snippet;
  };

  let { jobId, job, signals, workspaceId, triggerContents }: Props = $props();

  const queryClient = useQueryClient();

  let error = $state<string | null>(null);
  let isRunning = $state(false);
  let selectedSignalId = $state("");
  let formData = $state<Record<string, unknown>>({});

  const jobTitle = $derived(job.title ?? job.name ?? jobId);

  const triggerSignals = $derived(
    (job.triggers ?? [])
      .filter((t) => t.signal in signals)
      .map((t) => ({ id: t.signal, signal: signals[t.signal] })),
  );

  const isMultiTrigger = $derived(triggerSignals.length > 1);

  const activeSignalId = $derived(
    isMultiTrigger ? selectedSignalId : (triggerSignals[0]?.id ?? ""),
  );

  const activeSignal = $derived(activeSignalId ? signals[activeSignalId] : undefined);

  const activeSchema = $derived(activeSignal?.schema);

  type FieldDef = { type?: string; description?: string };

  const FieldDefSchema = z.object({
    type: z.string().optional(),
    description: z.string().optional(),
  });

  function parseFieldDef(value: unknown): FieldDef {
    const result = FieldDefSchema.safeParse(value);
    return result.success ? result.data : {};
  }

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
  }

  async function handleSubmit(open: { set: (v: boolean) => void }) {
    if (!activeSignalId) {
      error = "Please select a signal to trigger";
      return;
    }

    if (hasSchema) {
      for (const field of requiredFields) {
        const value = formData[field];
        if (value === undefined || value === "") {
          error = `Field "${field}" is required`;
          return;
        }
      }
    }

    const signalId = activeSignalId;
    const payload = hasSchema ? { ...formData } : undefined;

    isRunning = true;

    // Fire the signal — don't await, it blocks until the job completes
    const signalPromise = parseResult(
      client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId },
        json: { payload },
      }),
    );

    // Give the backend a moment to register the session in memory
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] });

    isRunning = false;
    open.set(false);
    resetForm();
    toast({ title: "Job triggered", description: jobTitle });

    signalPromise.then((result) => {
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] });
        toast({
          title: "Job completed",
          description: jobTitle,
          viewLabel: "View Session",
          viewAction: () => goto(`/spaces/${workspaceId}/sessions/${result.data.sessionId}`),
        });
      } else {
        toast({ title: "Job failed", description: stringifyError(result.error), error: true });
      }
    });
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
      {@render triggerContents()}
    </Dialog.Trigger>

    <Dialog.Content size="large">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Run {jobTitle}?</Dialog.Title>
        {#if job.description}
          <Dialog.Description>{job.description}</Dialog.Description>
        {/if}
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
              <div class="field">
                <label for={fieldId}>
                  {fieldName}
                  {#if isRequired}<span class="required">*</span>{/if}
                </label>
                {#if fieldDef.description}
                  <span class="field-description">{fieldDef.description}</span>
                {/if}
                {#if fieldDef.type === "boolean"}
                  <label class="checkbox-label">
                    <input
                      id={fieldId}
                      type="checkbox"
                      checked={formData[fieldName] === true}
                      onchange={(e) => {
                        formData[fieldName] = e.currentTarget.checked;
                      }}
                    />
                    <span>Enabled</span>
                  </label>
                {:else if fieldDef.type === "number" || fieldDef.type === "integer"}
                  <input
                    id={fieldId}
                    type="number"
                    value={formData[fieldName] ?? ""}
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
            <div class="error">
              {error}
            </div>
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
    border-color: var(--color-yellow);
    outline: none;
  }

  input[type="text"]:disabled,
  input[type="number"]:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  input[type="text"]::placeholder,
  input[type="number"]::placeholder {
    color: color-mix(in oklch, var(--color-text) 50%, transparent);
  }

  .radio-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-4);
    gap: var(--size-2);
    opacity: 1;
  }

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
