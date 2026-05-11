<!--
  Pure presentational card for a pending `auth-refresh` elicitation.

  Renders the question text + Retry/Cancel buttons with stable
  testids. The parent owns the elicitation source, the answer-in-
  flight signal, and the click handler — keeps this component cheap
  to unit-test without a QueryClient.

  @component
-->

<script lang="ts">
  import { Button } from "@atlas/ui";

  interface Props {
    elicitationId: string;
    question: string;
    /** True while an answer mutation is in flight; disables both
        buttons and swaps Retry's label to "Answering…". */
    inFlight: boolean;
    /** Set when the latest answer attempt failed; surfaced as inline
        error copy so the operator can re-click. */
    errorMessage?: string;
    onanswer: (value: "retry" | "cancel") => void;
  }

  let { elicitationId, question, inFlight, errorMessage, onanswer }: Props = $props();
</script>

<div class="card" data-testid="auth-refresh-inline-card" data-elicitation-id={elicitationId}>
  <div class="card-header">
    <span class="eyebrow">Reconnecting</span>
  </div>
  <div class="question">{question}</div>
  <div class="actions">
    <Button
      onclick={() => onanswer("retry")}
      disabled={inFlight}
      data-testid="elicitation-auth-refresh-retry"
    >
      {inFlight ? "Answering…" : "Retry"}
    </Button>
    <Button
      variant="destructive"
      onclick={() => onanswer("cancel")}
      disabled={inFlight}
      data-testid="elicitation-auth-refresh-cancel"
    >
      {inFlight ? "Answering…" : "Cancel"}
    </Button>
  </div>
  {#if errorMessage}
    <p class="error">Answer failed: {errorMessage}</p>
  {/if}
</div>

<style>
  .card {
    background-color: color-mix(in srgb, var(--yellow-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--yellow-primary), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .eyebrow {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-7);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .question {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    line-height: 1.35;
    white-space: pre-wrap;
  }

  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .error {
    color: var(--red-primary);
    font-size: var(--font-size-1);
    margin: 0;
  }
</style>
