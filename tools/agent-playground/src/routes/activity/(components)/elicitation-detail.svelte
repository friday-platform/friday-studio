<!--
  Detail panel for a single elicitation.

  Shows the full question + pendingTool args (if present), renders any
  pre-declared options as primary buttons, and exposes a free-text note
  field. Operator picks an option (or types a free-form value into a
  fallback input for `open-question` kind), then [Answer] or [Decline].

  Read-only when the elicitation is no longer pending — keeps the same
  layout so operators can still inspect what was asked + what was
  answered, but disables every control.

  @component
-->

<script lang="ts">
  import type { Elicitation, ElicitationStatus } from "@atlas/core/elicitations/model";
  import { Button } from "@atlas/ui";
  import {
    useAnswerElicitation,
    useDeclineElicitation,
  } from "$lib/queries/elicitation-queries.ts";

  type Props = {
    elicitation: Elicitation;
    /** Live "now" tick so the panel agrees with the row about expiry. */
    nowMs: number;
  };

  let { elicitation, nowMs }: Props = $props();

  const effectiveStatus = $derived<ElicitationStatus>(
    elicitation.status === "pending" && new Date(elicitation.expiresAt).getTime() <= nowMs
      ? "expired"
      : elicitation.status,
  );

  const isReadOnly = $derived(effectiveStatus !== "pending");

  /**
   * Form state. Reset whenever the operator switches to a different
   * elicitation — `$derived(elicitation.id)` triggers the effect.
   * Pre-select the first option when present so [Answer] works on a
   * single click for the common allowlist denial flow.
   */
  let selectedValue = $state<string>("");
  let freeText = $state<string>("");
  let note = $state<string>("");

  $effect(() => {
    // Reset on switch. Read `elicitation.id` so the effect re-runs.
    elicitation.id;
    selectedValue = elicitation.options?.[0]?.value ?? "";
    freeText = "";
    note = "";
  });

  const answerMutation = useAnswerElicitation();
  const declineMutation = useDeclineElicitation();

  const inFlight = $derived(answerMutation.isPending || declineMutation.isPending);

  const hasOptions = $derived((elicitation.options?.length ?? 0) > 0);

  /**
   * Effective answer value:
   *  - if options present → the chosen option's value
   *  - otherwise → the free-text input
   *
   * The button stays disabled when the result would be empty so we
   * don't POST a meaningless `value: ""` to the daemon.
   */
  const answerValue = $derived(hasOptions ? selectedValue : freeText.trim());
  const canAnswer = $derived(!isReadOnly && !inFlight && answerValue.length > 0);

  function onAnswer() {
    if (!canAnswer) return;
    answerMutation.mutate({
      id: elicitation.id,
      value: answerValue,
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
    });
  }

  function onDecline() {
    if (isReadOnly || inFlight) return;
    declineMutation.mutate({
      id: elicitation.id,
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
    });
  }

  /** Pretty-print pendingTool.args for inspection. */
  const pendingArgsJson = $derived(
    elicitation.pendingTool ? JSON.stringify(elicitation.pendingTool.args, null, 2) : "",
  );
</script>

<div class="detail">
  <header class="detail-header">
    <span class="kind">{elicitation.kind}</span>
    <h2>{elicitation.question}</h2>
    <div class="meta">
      <span>workspace: <code>{elicitation.workspaceId}</code></span>
      <span class="sep">·</span>
      <span>session: <code>{elicitation.sessionId}</code></span>
      {#if elicitation.actionId}
        <span class="sep">·</span>
        <span>action: <code>{elicitation.actionId}</code></span>
      {/if}
    </div>
  </header>

  {#if elicitation.pendingTool}
    <section class="block">
      <h3>Pending tool</h3>
      <p class="block-line"><code>{elicitation.pendingTool.name}</code></p>
      <pre class="args">{pendingArgsJson}</pre>
    </section>
  {/if}

  {#if elicitation.answer}
    <section class="block">
      <h3>Answer recorded</h3>
      <p class="block-line">
        <code>{elicitation.answer.value}</code>
        <span class="muted">
          ({new Date(elicitation.answer.answeredAt).toLocaleString()})
        </span>
      </p>
      {#if elicitation.answer.note}
        <p class="block-line muted">{elicitation.answer.note}</p>
      {/if}
    </section>
  {/if}

  {#if !isReadOnly}
    <section class="block">
      <h3>Respond</h3>

      {#if hasOptions}
        <div class="options" role="radiogroup">
          {#each elicitation.options ?? [] as opt (opt.value)}
            <label class="option" class:active={selectedValue === opt.value}>
              <input
                type="radio"
                name="answer-{elicitation.id}"
                value={opt.value}
                bind:group={selectedValue}
                disabled={inFlight}
              />
              <span>{opt.label}</span>
            </label>
          {/each}
        </div>
      {:else}
        <label class="field">
          <span class="field-label">Answer</span>
          <input
            type="text"
            bind:value={freeText}
            disabled={inFlight}
            placeholder="Type your response…"
          />
        </label>
      {/if}

      <label class="field">
        <span class="field-label">Note (optional)</span>
        <textarea
          bind:value={note}
          disabled={inFlight}
          rows="2"
          placeholder="Context for the audit log"
        ></textarea>
      </label>

      <div class="actions">
        <Button onclick={onAnswer} disabled={!canAnswer}>
          {answerMutation.isPending ? "Answering…" : "Answer"}
        </Button>
        <Button variant="destructive" onclick={onDecline} disabled={inFlight}>
          {declineMutation.isPending ? "Declining…" : "Decline"}
        </Button>
      </div>

      {#if answerMutation.isError}
        <p class="error">Answer failed: {answerMutation.error?.message ?? "unknown"}</p>
      {/if}
      {#if declineMutation.isError}
        <p class="error">Decline failed: {declineMutation.error?.message ?? "unknown"}</p>
      {/if}
    </section>
  {:else}
    <section class="block">
      <p class="muted">
        This elicitation is {effectiveStatus} and can no longer be acted on.
      </p>
    </section>
  {/if}
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-4);
  }

  .detail-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .detail-header h2 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .kind {
    align-self: flex-start;
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    padding: 1px var(--size-2);
    text-transform: uppercase;
  }

  .meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .meta code {
    font-family: monospace;
  }

  .sep {
    opacity: 0.4;
  }

  .block {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .block h3 {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }

  .block-line {
    font-size: var(--font-size-2);
    margin: 0;
  }

  .block-line code {
    background-color: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-1);
    font-family: monospace;
    padding: 1px var(--size-1);
  }

  .muted {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .args {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
    border-radius: var(--radius-2);
    font-family: monospace;
    font-size: var(--font-size-1);
    margin: 0;
    max-block-size: 12rem;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .option {
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
    transition: border-color 120ms ease, background-color 120ms ease;
  }

  .option:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .option.active {
    border-color: var(--color-accent, #1f6feb);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .field input,
  .field textarea {
    background-color: var(--surface, white);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font: inherit;
    padding: var(--size-2);
    resize: vertical;
  }

  .field input:focus,
  .field textarea:focus {
    border-color: var(--color-accent, #1f6feb);
    outline: none;
  }

  .actions {
    display: flex;
    gap: var(--size-2);
    margin-block-start: var(--size-1);
  }

  .error {
    color: var(--color-warning, #d29922);
    font-size: var(--font-size-1);
    margin: 0;
  }
</style>
