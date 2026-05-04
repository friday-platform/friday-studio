<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import type { ValidationIssue, ValidationVerdict } from "@atlas/hallucination/verdict";

  /**
   * Pure presentational pill row for a single validation attempt.
   * One row per attempt; rendered after the tool calls of the action being validated.
   * Pass/uncertain auto-collapse, fail expands by default.
   */

  interface Props {
    attempt: number;
    status: "running" | "passed" | "failed";
    /** Present on `failed`; `true` only on terminal failure. */
    terminal?: boolean;
    /** Present on `passed` and `failed` events; absent on `running`. */
    verdict?: ValidationVerdict;
  }

  const { attempt, status, terminal, verdict }: Props = $props();

  /* ─── Lifecycle classification ───────────────────────────────────── */

  type Lifecycle =
    | "running"
    | "passed-from-pass"
    | "passed-from-uncertain"
    | "failed-retrying"
    | "failed-terminal";

  function classify(
    s: Props["status"],
    t: Props["terminal"],
    v: Props["verdict"],
  ): Lifecycle {
    if (s === "running") return "running";
    if (s === "passed") {
      return v?.status === "uncertain" ? "passed-from-uncertain" : "passed-from-pass";
    }
    return t === true ? "failed-terminal" : "failed-retrying";
  }

  const lifecycle = $derived(classify(status, terminal, verdict));

  type Tone = "blue" | "green" | "yellow" | "red";

  const tone = $derived<Tone>(
    lifecycle === "running"
      ? "blue"
      : lifecycle === "passed-from-pass"
        ? "green"
        : lifecycle === "passed-from-uncertain"
          ? "yellow"
          : "red",
  );

  const headline = $derived(
    lifecycle === "running"
      ? "Validating output"
      : lifecycle === "passed-from-pass"
        ? "Validation passed"
        : lifecycle === "passed-from-uncertain"
          ? "Validation uncertain"
          : lifecycle === "failed-retrying"
            ? "Validation failed — retrying"
            : "Validation failed",
  );

  const expandable = $derived(lifecycle !== "running");

  /* ─── Expand state ───────────────────────────────────────────────── */

  // Fail starts expanded; pass/uncertain start collapsed; running has no expansion.
  const startsExpanded = $derived(
    lifecycle === "failed-retrying" || lifecycle === "failed-terminal",
  );
  let userToggled = $state<boolean | null>(null);
  const expanded = $derived(userToggled ?? startsExpanded);

  function toggle(e: Event) {
    e.preventDefault();
    if (!expandable) return;
    userToggled = !expanded;
  }

  /* ─── Confidence / threshold pill ───────────────────────────────── */

  function fmt(n: number): string {
    return n.toFixed(2);
  }

  const confidenceText = $derived(
    verdict ? `${fmt(verdict.confidence)} / ${fmt(verdict.threshold)}` : null,
  );

  /* ─── Issue rendering ────────────────────────────────────────────── */

  function severityTone(severity: ValidationIssue["severity"]): "red" | "yellow" | "neutral" {
    switch (severity) {
      case "error":
        return "red";
      case "warn":
        return "yellow";
      case "info":
        return "neutral";
    }
  }

  function citationDisplay(citation: string | null): string {
    if (citation === null) return "(no supporting tool call)";
    return citation;
  }
</script>

<div
  class="validation-pill"
  class:tone-blue={tone === "blue"}
  class:tone-green={tone === "green"}
  class:tone-yellow={tone === "yellow"}
  class:tone-red={tone === "red"}
  class:expanded
  data-lifecycle={lifecycle}
>
  {#if expandable}
    <button
      type="button"
      class="pill-header"
      aria-expanded={expanded}
      onclick={toggle}
    >
      {@render headerInner()}
    </button>
  {:else}
    <div class="pill-header non-interactive">
      {@render headerInner()}
    </div>
  {/if}

  {#if expanded && verdict}
    <div class="pill-body">
      {#if verdict.retryGuidance}
        <div class="retry-guidance">
          <span class="body-label">Retry guidance</span>
          <p class="body-text">{verdict.retryGuidance}</p>
        </div>
      {/if}

      {#if verdict.issues.length > 0}
        <ul class="issue-list">
          {#each verdict.issues as issue, i (i)}
            {@const sevTone = severityTone(issue.severity)}
            <li
              class="issue-row"
              class:sev-red={sevTone === "red"}
              class:sev-yellow={sevTone === "yellow"}
              class:sev-neutral={sevTone === "neutral"}
            >
              <div class="issue-head">
                <span class="category-badge">{issue.category}</span>
                <span class="severity-badge">{issue.severity}</span>
              </div>
              {#if issue.claim}
                <div class="issue-field">
                  <span class="body-label">Claim</span>
                  <p class="body-text">{issue.claim}</p>
                </div>
              {/if}
              {#if issue.reasoning}
                <div class="issue-field">
                  <span class="body-label">Reasoning</span>
                  <p class="body-text">{issue.reasoning}</p>
                </div>
              {/if}
              <div class="issue-field">
                <span class="body-label">Citation</span>
                <p
                  class="body-text citation"
                  class:citation-empty={issue.citation === null}
                >{citationDisplay(issue.citation)}</p>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

{#snippet headerInner()}
  <span class="status-icon" aria-hidden="true">
    {#if tone === "blue"}
      <span class="spinner-dot"></span>
    {:else if tone === "green"}
      <IconSmall.CheckCircle />
    {:else if tone === "yellow"}
      <IconSmall.Clock />
    {:else}
      <IconSmall.XCircle />
    {/if}
  </span>
  <span class="pill-headline">{headline}</span>
  <span class="attempt-tag">attempt {attempt}</span>
  {#if confidenceText}
    <span class="confidence-tag" title="confidence / threshold">{confidenceText}</span>
  {/if}
  <span class="pill-spacer"></span>
  {#if expandable}
    <span class="pill-chevron" aria-hidden="true">
      {#if expanded}
        <IconSmall.ChevronDown />
      {:else}
        <IconSmall.ChevronRight />
      {/if}
    </span>
  {/if}
{/snippet}

<style>
  .validation-pill {
    background-color: var(--surface-dark);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    border-inline-start: 3px solid var(--band-color);
    font-size: var(--font-size-2);
    overflow: hidden;
    --band-color: var(--text-faded);
  }

  .validation-pill.tone-blue { --band-color: var(--blue-primary); }
  .validation-pill.tone-green { --band-color: var(--green-primary); }
  .validation-pill.tone-yellow { --band-color: var(--yellow-primary); }
  .validation-pill.tone-red { --band-color: var(--red-primary); }

  .pill-header {
    align-items: center;
    background-color: var(--surface);
    border: none;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--size-1-5);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2-5);
    text-align: start;
  }

  .pill-header.non-interactive {
    cursor: default;
  }

  .pill-header:hover:not(.non-interactive) {
    background-color: color-mix(in srgb, var(--surface), var(--text-faded) 4%);
  }

  .status-icon {
    color: var(--band-color);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
  }

  .status-icon :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .spinner-dot {
    background-color: var(--band-color);
    border-radius: 50%;
    display: inline-block;
    inline-size: 10px;
    block-size: 10px;
    margin: 2px;
    animation: pill-pulse 1.2s ease-in-out infinite;
  }

  @keyframes pill-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .pill-headline {
    color: var(--text-bright);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attempt-tag,
  .confidence-tag {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    background-color: color-mix(in srgb, var(--band-color), transparent 92%);
    border-radius: var(--radius-1);
    padding: 2px 7px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .pill-spacer {
    flex: 1;
  }

  .pill-chevron {
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    opacity: 0.6;
  }

  .pill-chevron :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  /* ─── Body ───────────────────────────────────────────────────────── */

  .pill-body {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-2-5);
  }

  .body-label {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
  }

  .body-text {
    color: var(--text);
    font-size: var(--font-size-2);
    line-height: 1.45;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .retry-guidance {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .issue-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .issue-row {
    border-inline-start: 2px solid var(--issue-color);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-inline-start: var(--size-2);
    --issue-color: var(--text-faded);
  }

  .issue-row.sev-red { --issue-color: var(--red-primary); }
  .issue-row.sev-yellow { --issue-color: var(--yellow-primary); }
  .issue-row.sev-neutral { --issue-color: var(--text-faded); }

  .issue-head {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .category-badge,
  .severity-badge {
    color: var(--issue-color);
    background-color: color-mix(in srgb, var(--issue-color), transparent 90%);
    border-radius: var(--radius-1);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    padding: 1px 6px;
  }

  .severity-badge {
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .issue-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .citation {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1, 12px);
    color: var(--text-faded);
  }

  .citation-empty {
    font-style: italic;
    opacity: 0.7;
  }
</style>
