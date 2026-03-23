<!--
  Horizontal pipeline diagram for workspace topology.

  Renders topology nodes as a compact horizontal row: signal card first,
  then agent step pills connected by arrow connectors. Designed for the
  common linear pipeline case.

  @component
  @param {import("@atlas/config").Topology} topology - Derived topology data
  @param {string | null} [selectedNodeId] - Currently selected node ID
  @param {(node: import("@atlas/config").TopologyNode) => void} [onNodeClick] - Node click handler
-->

<script lang="ts">
  import type { Topology, TopologyNode } from "@atlas/config";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";

  type Props = {
    topology: Topology;
    selectedNodeId?: string | null;
    onNodeClick?: (node: TopologyNode) => void;
  };

  let {
    topology,
    selectedNodeId = null,
    onNodeClick,
  }: Props = $props();

  /** Signal nodes rendered as the first card(s) in the row. */
  const signalNodes = $derived(topology.nodes.filter((n) => n.type === "signal"));

  /** Agent step nodes in order. */
  const stepNodes = $derived(topology.nodes.filter((n) => n.type === "agent-step"));

  /** All nodes in pipeline order: signals first, then steps. */
  const pipelineNodes = $derived([...signalNodes, ...stepNodes]);

  const hasUnsupported = $derived(
    topology.unsupportedJobs && topology.unsupportedJobs.length > 0,
  );

  const allExecutionMode = $derived(
    hasUnsupported && topology.nodes.filter((n) => n.type !== "signal").length === 0,
  );

  /** Signal type badge label. */
  function signalBadge(node: TopologyNode): string {
    const provider = node.metadata.provider;
    if (provider === "http") return "HTTP";
    if (provider === "cron") return "Cron";
    return "Manual";
  }

  /** Signal type badge CSS modifier. */
  function signalBadgeClass(node: TopologyNode): string {
    const provider = node.metadata.provider;
    if (provider === "http") return "badge--http";
    if (provider === "cron") return "badge--cron";
    return "badge--manual";
  }

  /** Humanized step name from state ID. */
  function stepName(node: TopologyNode): string {
    return humanizeStepName(node.label);
  }

  /** Workspace agent name shown as secondary label. */
  function agentName(node: TopologyNode): string | null {
    if (node.metadata.agentId) return String(node.metadata.agentId);
    return null;
  }
</script>

{#if allExecutionMode}
  <div class="execution-mode-notice">
    <p class="notice-title">Execution-mode jobs only</p>
    <p class="notice-body">
      This workspace uses execution-mode jobs which are not supported in the pipeline view.
      Migrate to FSM-based jobs to see the visual pipeline.
    </p>
  </div>
{:else}
  <div class="pipeline" role="img" aria-label="Workspace pipeline diagram">
    {#each pipelineNodes as node, i (node.id)}
      <!-- Horizontal arrow connector between cards -->
      {#if i > 0}
        <svg
          class="connector"
          width="24"
          height="12"
          viewBox="0 0 24 12"
          aria-hidden="true"
        >
          <line x1="0" y1="6" x2="18" y2="6" stroke="var(--color-border-1)" stroke-width="1" />
          <polygon points="18,2 24,6 18,10" fill="var(--color-border-1)" />
        </svg>
      {/if}

      {#if node.type === "signal"}
        <button
          class="card card--signal"
          class:card--selected={selectedNodeId === node.id}
          onclick={() => onNodeClick?.(node)}
        >
          <span class="badge {signalBadgeClass(node)}">{signalBadge(node)}</span>
          <span class="card-label">{node.metadata.title ?? node.label}</span>
        </button>
      {:else if node.type === "agent-step"}
        <button
          class="card card--step"
          class:card--selected={selectedNodeId === node.id}
          onclick={() => onNodeClick?.(node)}
        >
          <div class="step-header">
            <span class="step-name">{stepName(node)}</span>
          </div>
          {#if agentName(node)}
            <span class="agent-name">{agentName(node)}</span>
          {/if}
        </button>
      {/if}
    {/each}

    {#if hasUnsupported}
      <div class="unsupported-notice">
        <span class="unsupported-label">
          +{topology.unsupportedJobs?.length} execution-mode
          {topology.unsupportedJobs?.length === 1 ? "job" : "jobs"}
        </span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .pipeline {
    align-items: center;
    display: flex;
    flex-direction: row;
    gap: var(--size-4);
    overflow-x: auto;
    padding: var(--size-6) var(--size-4);
  }

  /* Fade edges for horizontal scroll */
  .pipeline {
    mask-image: linear-gradient(
      to right,
      transparent,
      black var(--size-4),
      black calc(100% - var(--size-4)),
      transparent
    );
    -webkit-mask-image: linear-gradient(
      to right,
      transparent,
      black var(--size-4),
      black calc(100% - var(--size-4)),
      transparent
    );
  }

  /* ---- Cards (shared) ---- */

  .card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    font-family: inherit;
    gap: var(--size-1);
    padding: var(--size-2) var(--size-3);
    text-align: start;
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  .card:hover {
    border-color: var(--color-border-2);
  }

  .card--selected {
    border-color: var(--color-info);
    box-shadow: 0 0 0 1px var(--color-info);
  }

  /* ---- Signal card ---- */

  .card--signal {
    align-items: flex-start;
  }

  /* ---- Step card ---- */

  .card--step {
  }

  /* ---- Signal badge ---- */

  .badge {
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-2);
    padding: var(--size-0-5) var(--size-1-5);
    text-transform: uppercase;
  }

  .badge--http {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .badge--cron {
    background-color: color-mix(in srgb, var(--color-warning), transparent 85%);
    color: var(--color-warning);
  }

  .badge--manual {
    background-color: color-mix(in srgb, var(--color-accent), transparent 85%);
    color: var(--color-accent);
  }

  /* ---- Card labels ---- */

  .card-label {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Step header (icon + name) ---- */

  .step-header {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .step-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Agent name (second line) ---- */

  .agent-name {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Horizontal arrow connectors ---- */

  .connector {
    flex-shrink: 0;
  }

  /* ---- Notices ---- */

  .execution-mode-notice {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-10);
    text-align: center;
  }

  .notice-title {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
  }

  .notice-body {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    max-inline-size: 360px;
  }

  .unsupported-notice {
    flex-shrink: 0;
    margin-inline-start: var(--size-2);
  }

  .unsupported-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-style: italic;
  }
</style>
