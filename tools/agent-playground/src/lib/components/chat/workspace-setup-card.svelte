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
  import { resolve } from "$app/paths";
  import { useAnswerElicitation } from "$lib/queries/elicitation-queries.ts";
  import SetupCredentialRow from "./setup-credential-row.svelte";
  import {
    allFieldsValid,
    buildSetupAnswerValue,
    credentialProviders,
    validateField,
    variableRequirements,
  } from "./workspace-setup-card.ts";

  interface Props {
    elicitation: Elicitation;
    workspaceId: string;
  }

  const { elicitation, workspaceId }: Props = $props();

  const variables = $derived(variableRequirements(elicitation.setupRequirements ?? []));
  const providers = $derived(credentialProviders(elicitation.setupRequirements ?? []));

  let values = $state<Record<string, string>>({});
  let touched = $state<Record<string, boolean>>({});
  let credentialChoices = $state<Record<string, string>>({});
  let submitAttempted = $state(false);

  const submittable = $derived(allFieldsValid(variables, values, providers, credentialChoices));
  const isPending = $derived(elicitation.status === "pending");

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);

  const activityHref = $derived(
    `${resolve("/platform/[workspaceId]/activity", { workspaceId })}?elicitationId=${encodeURIComponent(elicitation.id)}`,
  );

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
    <span class="eyebrow">Workspace setup</span>
    <span class="status" class:status-pending={isPending}>
      {#if isPending}
        pending
      {:else if elicitation.status === "answered"}
        applied
      {:else}
        {elicitation.status}
      {/if}
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
            <label class="var-label" for={inputId}>{req.name}</label>
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
        <Button type="submit" disabled={inFlight || !submittable}>
          {inFlight ? "Submitting…" : "Submit"}
        </Button>
        <Button href={activityHref} variant="none">Open Activity</Button>
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
    background-color: color-mix(in srgb, var(--blue-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--blue-primary), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-3);
  }

  .setup-card.pending {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue-primary), transparent 75%);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .eyebrow {
    color: color-mix(in srgb, var(--text), transparent 35%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-7);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .status {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--text), transparent 30%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-2);
  }

  .status-pending {
    background-color: color-mix(in srgb, var(--blue-primary), transparent 75%);
    color: color-mix(in srgb, var(--blue-primary), black 35%);
  }

  .lede {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    line-height: 1.4;
    margin: 0;
  }

  .var-list,
  .cred-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
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

  .hint,
  .error {
    font-size: var(--font-size-1);
    margin: 0;
  }

  .hint {
    color: color-mix(in srgb, var(--text), transparent 45%);
  }

  .terminal {
    color: var(--text);
  }

  .error {
    color: var(--red-primary);
  }
</style>
