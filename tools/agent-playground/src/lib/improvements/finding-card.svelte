<script lang="ts">
  import type { ApplyAction, ImprovementFinding } from "./types.ts";

  const {
    finding,
    onaction,
    disabled = false,
  }: {
    finding: ImprovementFinding;
    onaction: (action: ApplyAction) => void;
    disabled?: boolean;
  } = $props();
</script>

<article class="finding-card">
  <header class="card-header">
    <span class="job-badge">{finding.body.target_job_id}</span>
    <time class="timestamp">{finding.chunk.createdAt}</time>
  </header>

  {#if finding.body.rationale}
    <p class="rationale">{finding.body.rationale}</p>
  {/if}

  <div class="diff-container">
    <pre class="diff">{finding.body.diff}</pre>
  </div>

  <footer class="card-actions">
    <button
      class="btn btn-accept"
      disabled={disabled}
      onclick={() => onaction("accept")}
    >
      Accept
    </button>
    <button
      class="btn btn-reject"
      disabled={disabled}
      onclick={() => onaction("reject")}
    >
      Reject
    </button>
    <button
      class="btn btn-dismiss"
      disabled={disabled}
      onclick={() => onaction("dismiss")}
    >
      Dismiss
    </button>
  </footer>
</article>

<style>
  .finding-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .job-badge {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1-5);
  }

  .timestamp {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .rationale {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .diff-container {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    max-block-size: 300px;
    overflow: auto;
  }

  .diff {
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    line-height: 1.6;
    margin: 0;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .card-actions {
    display: flex;
    gap: var(--size-2);
    justify-content: flex-end;
  }

  .btn {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-3);
    transition: background 100ms ease;
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .btn-accept {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 85%);
    color: var(--color-text);
  }

  .btn-accept:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 75%);
  }

  .btn-reject {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 85%);
    color: var(--color-text);
  }

  .btn-reject:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 75%);
  }

  .btn-dismiss {
    background: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .btn-dismiss:hover:not(:disabled) {
    background: var(--color-surface-3);
    color: var(--color-text);
  }
</style>
