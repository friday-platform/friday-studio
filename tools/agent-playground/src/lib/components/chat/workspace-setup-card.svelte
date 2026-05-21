<!--
  Workspace-setup form rendered inline in the chat thread when a
  `workspace-setup` elicitation is pending for the active session.

  Renders:
  - One text input per variable requirement (name as label, optional
    description, blur-and-submit validation against the declared schema).
  - One credential picker per distinct provider in the credential
    requirements (`<SetupCredentialRow>`), which queries Link directly for
    the available credentials and exposes a "Connect another" affordance
    that runs the standard OAuth popup flow.

  Submit ships `{ variableValues, credentialChoices }` keyed by variable
  name and provider id respectively.

  @component
-->
<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { Button } from "@atlas/ui";
  import { useAnswerElicitation } from "$lib/queries/elicitation-queries.ts";
  import SetupCredentialRow from "./setup-credential-row.svelte";
  import {
    allFieldsValid,
    buildSetupAnswerValue,
    credentialProviders,
    labelFor,
    validateField,
    variableRequirements,
  } from "./workspace-setup-card.ts";

  interface Props {
    elicitation: Elicitation;
  }

  const { elicitation }: Props = $props();

  const variables = $derived(variableRequirements(elicitation.setupRequirements ?? []));
  const providers = $derived(credentialProviders(elicitation.setupRequirements ?? []));

  let values = $state<Record<string, string>>({});
  let touched = $state<Record<string, boolean>>({});
  let credentialChoices = $state<Record<string, string>>({});
  let submitAttempted = $state(false);

  // Rehydrate from `elicitation.answer.value` once the elicitation lands in an
  // answered state. Without this, a page refresh wipes the component's local
  // `values` and `credentialChoices` and the applied card shows empty inputs
  // even though .env holds the committed value. The answer envelope persists
  // the structured payload plaintext (variables aren't `sensitive` in v1).
  $effect(() => {
    const answer = elicitation.answer?.value;
    if (!answer || typeof answer !== "object") return;
    const seededValues: Record<string, string> = {};
    for (const [name, typed] of Object.entries(answer.variableValues ?? {})) {
      if (typed === null || typed === undefined) continue;
      seededValues[name] = String(typed);
    }
    if (Object.keys(seededValues).length > 0) values = seededValues;
    if (Object.keys(answer.credentialChoices ?? {}).length > 0) {
      credentialChoices = { ...answer.credentialChoices };
    }
  });

  const submittable = $derived(allFieldsValid(variables, values, providers, credentialChoices));
  const isPending = $derived(elicitation.status === "pending");

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);

  function fieldError(name: string): string | null {
    const raw = values[name] ?? "";
    const shouldShow = submitAttempted || touched[name];
    if (!shouldShow) return null;
    if (raw.length === 0) return submitAttempted ? "Required." : null;
    const req = variables.find((v) => v.name === name);
    if (!req) return null;
    const result = validateField(req, raw);
    return result.ok ? null : result.message;
  }

  function onCredentialChange(provider: string, credentialId: string) {
    credentialChoices = { ...credentialChoices, [provider]: credentialId };
  }

  function summaryLede(variableCount: number, providerCount: number): string {
    const parts: string[] = [];
    if (variableCount > 0) parts.push(`${variableCount} variable${variableCount === 1 ? "" : "s"}`);
    if (providerCount > 0) {
      parts.push(`${providerCount} credential${providerCount === 1 ? "" : "s"}`);
    }
    return `Fill in ${parts.join(" and ")} to finish setting up this workspace.`;
  }

  const statusLabel = $derived.by(() => {
    if (isPending) return "pending";
    if (elicitation.status === "answered") return "applied";
    return elicitation.status;
  });

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    submitAttempted = true;
    if (!isPending || inFlight || !submittable) return;
    answerMutation.mutate({
      id: elicitation.id,
      value: buildSetupAnswerValue(variables, values, providers, credentialChoices),
    });
  }
</script>

<form
  class="setup-card"
  class:pending={isPending}
  onsubmit={onSubmit}
  data-testid="workspace-setup-card"
>
  <div class="card-header">
    <h3 class="card-title">Workspace setup</h3>
    <span
      class="status"
      class:status-pending={statusLabel === "pending"}
      class:status-applied={statusLabel === "applied"}
      class:status-denied={statusLabel === "declined"}
    >
      {statusLabel}
    </span>
  </div>

  {#if variables.length === 0 && providers.length === 0}
    <p class="hint">No setup inputs requested.</p>
  {:else}
    <p class="lede">{summaryLede(variables.length, providers.length)}</p>

    {#if variables.length > 0}
      <div class="var-list">
        {#each variables as req (req.name)}
          {@const error = fieldError(req.name)}
          {@const inputId = `setup-${elicitation.id}-${req.name}`}
          <div class="var-group" class:invalid={error !== null}>
            <label
              class="var-label"
              class:var-label-display={req.display_name !== undefined}
              for={inputId}
            >
              {labelFor(req)}
            </label>
            {#if req.description}
              <p class="var-description">{req.description}</p>
            {/if}
            <input
              id={inputId}
              class="var-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              disabled={!isPending || inFlight}
              value={values[req.name] ?? ""}
              oninput={(e) => {
                values = { ...values, [req.name]: e.currentTarget.value };
              }}
              onblur={() => {
                touched = { ...touched, [req.name]: true };
              }}
            />
            {#if error !== null}
              <p class="validation-error" role="alert">{error}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if providers.length > 0}
      <div class="cred-list" data-testid="setup-credential-list">
        {#each providers as provider (provider)}
          <div class="cred-group">
            <span class="var-label">{provider}</span>
            <p class="var-description">Pick a credential for this provider.</p>
            <SetupCredentialRow
              {provider}
              selectedCredentialId={credentialChoices[provider]}
              disabled={!isPending || inFlight}
              onChange={(credentialId) => onCredentialChange(provider, credentialId)}
            />
          </div>
        {/each}
      </div>
    {/if}

    {#if isPending}
      <div class="actions">
        <div class="actions-buttons">
          <Button type="submit" disabled={inFlight || !submittable}>
            {inFlight ? "Completing…" : "Complete setup"}
          </Button>
        </div>
      </div>
    {:else}
      <p class="hint terminal">
        {#if elicitation.status === "answered"}
          Submitted — workspace setup complete.
        {:else}
          {elicitation.status} — no values were written.
        {/if}
      </p>
    {/if}

    {#if answerMutation.isError}
      <p class="error" role="alert">
        Failed: {answerMutation.error?.message ?? "unknown"}
      </p>
    {/if}
  {/if}
</form>

<style>
  .setup-card {
    align-self: flex-start;
    background-color: var(--surface-dark);
    border: 1px solid transparent;
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: var(--size-128);
    margin-block-end: var(--size-4);
    min-inline-size: 0;
    padding: var(--size-3);
  }

  .setup-card.pending {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-info), transparent 50%);
  }

  .card-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .card-title {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    line-height: 1.35;
    margin: 0;
  }

  .status {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-1);
    color: var(--text-faded);
    display: inline-block;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 1px var(--size-1-5);
    text-transform: capitalize;
  }

  .status-pending {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .status-applied {
    background-color: color-mix(in srgb, var(--green-primary), transparent 85%);
    color: var(--green-primary);
  }

  .status-denied {
    background-color: color-mix(in srgb, var(--red-primary), transparent 85%);
    color: var(--red-primary);
  }

  .lede {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
  }

  .var-list,
  .cred-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .var-group,
  .cred-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .var-label {
    color: var(--text-bright);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
  }

  /* Friendly display_name labels render in the body sans font at a larger
     step — monospace earns its place for snake_case env keys, but reads
     wrong for proper-case prose like "Email Recipient". */
  .var-label.var-label-display {
    font-family: inherit;
    font-size: var(--font-size-2);
  }

  .var-description {
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
  }

  .var-input {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-1-5) var(--size-2);
  }

  .var-input:focus {
    border-color: var(--blue-primary);
    outline: none;
  }

  .var-input:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .var-group.invalid .var-input {
    border-color: var(--red-primary);
  }

  .validation-error {
    color: var(--red-primary);
    font-size: var(--font-size-1);
    line-height: 1.35;
    margin: 0;
  }

  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .actions-buttons {
    display: flex;
    gap: var(--size-1-5);
    margin-inline-start: auto;
  }

  .hint,
  .error {
    font-size: var(--font-size-1);
    margin: 0;
  }

  .hint {
    color: var(--text-faded);
  }

  .terminal {
    color: var(--text);
  }

  .error {
    color: var(--red-primary);
  }
</style>
