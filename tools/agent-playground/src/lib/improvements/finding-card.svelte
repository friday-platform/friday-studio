<script lang="ts">
  import type { ApplyAction, ImprovementEntry, ImprovementType } from "./types.ts";
  import { computeUnifiedDiff, parseDiffStats } from "./diff-renderer.ts";

  const {
    finding,
    currentConfig,
    onaction,
    disabled = false,
  }: {
    finding: ImprovementEntry;
    currentConfig?: string;
    onaction: (action: ApplyAction) => void;
    disabled?: boolean;
  } = $props();

  const diff = $derived(
    finding.proposedFullConfig
      ? computeUnifiedDiff(
          currentConfig ?? finding.beforeYaml ?? "",
          finding.proposedFullConfig,
        )
      : finding.beforeYaml
        ? computeUnifiedDiff(finding.beforeYaml, finding.body)
        : finding.body,
  );

  const diffStats = $derived(
    (finding.proposedFullConfig || finding.beforeYaml) ? parseDiffStats(diff) : null,
  );

  const isApplied = $derived(finding.status === "applied");

  const TYPE_LABELS: Record<ImprovementType, string> = {
    skill_update: "Skill",
    signal_patch: "Signal",
    agent_replace: "Agent",
    source_mod: "Source",
  };

  const TYPE_COLORS: Record<ImprovementType, string> = {
    skill_update: "var(--color-info, #3b82f6)",
    signal_patch: "var(--color-warning, #f59e0b)",
    agent_replace: "var(--color-error, #ef4444)",
    source_mod: "var(--color-success, #22c55e)",
  };

  const diffTarget = $derived(inferDiffTarget(finding));

  function inferDiffTarget(entry: ImprovementEntry): string {
    if (entry.proposedFullConfig) return "workspace.yml";
    if (entry.improvementType === "skill_update") return "SKILL.md";
    if (entry.improvementType === "agent_replace") return "agent.py";
    if (entry.improvementType === "signal_patch") return "workspace.yml (signal)";
    return "workspace.yml";
  }
</script>

<article class="finding-card">
  <header class="card-header">
    <div class="badge-group">
      <span class="job-badge">{finding.targetJobId}</span>
      {#if finding.improvementType}
        <span
          class="type-badge"
          style="--badge-color: {TYPE_COLORS[finding.improvementType]}"
        >
          {TYPE_LABELS[finding.improvementType]}
        </span>
      {/if}
    </div>
    <div class="header-meta">
      <time class="timestamp">{finding.createdAt}</time>
      {#if diffStats}
        <span class="diff-stats">+{diffStats.additions} / -{diffStats.deletions}</span>
      {/if}
    </div>
  </header>

  {#if finding.text}
    <p class="rationale">{finding.text}</p>
  {/if}

  <div class="diff-container">
    <div class="diff-header">{diffTarget}</div>
    <pre class="diff">{diff}</pre>
  </div>

  <footer class="card-actions">
    {#if isApplied}
      <button
        class="btn btn-rollback"
        disabled={disabled}
        onclick={() => onaction("rollback")}
      >
        Rollback
      </button>
    {:else}
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
    {/if}
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

  .badge-group {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .header-meta {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .job-badge {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1-5);
  }

  .type-badge {
    background: color-mix(in srgb, var(--badge-color), transparent 85%);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-size: var(--font-size-0, 0.625rem);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
    text-transform: uppercase;
  }

  .timestamp {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .diff-stats {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-mono);
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

  .diff-header {
    background: var(--color-surface-3);
    border-block-end: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-mono);
    font-size: var(--font-size-0, 0.625rem);
    padding: var(--size-1) var(--size-3);
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

  .btn-rollback {
    background: color-mix(in srgb, var(--color-warning, #f59e0b), transparent 85%);
    color: var(--color-text);
  }

  .btn-rollback:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-warning, #f59e0b), transparent 75%);
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
