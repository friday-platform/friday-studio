<!--
  Horizontal pipeline diagram for workspace topology.

  Renders topology nodes as a compact horizontal row: signal card first,
  then agent step pills connected by arrow connectors. Designed for the
  common linear pipeline case.

  @component
  @param {import("@atlas/config").Topology} topology - Derived topology data
  @param {string | null} [selectedNodeId] - Currently selected node ID
  @param {(node: import("@atlas/config").TopologyNode) => void} [onNodeClick] - Node click handler
  @param {boolean} [compact] - Render as ~24px tall pills without card treatment (for header breadcrumb)
  @param {Set<string>} [disabledSteps] - Set of step state IDs that are disabled
  @param {(stateId: string) => void} [onToggleStep] - Toggle a step's disabled state
-->

<script lang="ts">
  import type { Topology, TopologyNode } from "@atlas/config";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { DropdownMenu, Icons } from "@atlas/ui";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";

  type Props = {
    topology: Topology;
    selectedNodeId?: string | null;
    onNodeClick?: (node: TopologyNode) => void;
    compact?: boolean;
    /** Maps node IDs to AgentBlock status strings for live status overlays. */
    nodeStatusMap?: Record<string, string>;
    /** Set of step state IDs that are disabled. */
    disabledSteps?: Set<string>;
    /** Toggle a step's disabled state. */
    onToggleStep?: (stateId: string) => void;
  };

  let {
    topology,
    selectedNodeId = null,
    onNodeClick,
    compact = false,
    nodeStatusMap = {},
    disabledSteps = new Set(),
    onToggleStep,
  }: Props = $props();

  /**
   * Extract the FSM state ID from a topology node ID.
   * Node IDs use the format "jobId:stateId".
   */
  function stateIdFromNode(node: TopologyNode): string {
    return node.id.includes(":") ? node.id.split(":").slice(1).join(":") : node.label;
  }

  /** Whether a step node is disabled. */
  function isDisabled(node: TopologyNode): boolean {
    return disabledSteps.has(stateIdFromNode(node));
  }

  /** Signal nodes rendered as the first card(s) in the row. */
  const signalNodes = $derived(topology.nodes.filter((n) => n.type === "signal"));

  /** Agent step nodes in order. */
  const stepNodes = $derived(topology.nodes.filter((n) => n.type === "agent-step"));

  /** All nodes in pipeline order: signals first, then steps. */
  const pipelineNodes = $derived([...signalNodes, ...stepNodes]);

  const hasUnsupported = $derived(topology.unsupportedJobs && topology.unsupportedJobs.length > 0);

  const allExecutionMode = $derived(
    hasUnsupported && topology.nodes.filter((n) => n.type !== "signal").length === 0,
  );

  /** Signal type badge label. */
  function signalBadge(node: TopologyNode): string {
    const provider = node.metadata.provider;
    if (provider === "http") return "HTTP";
    if (provider === "cron") return "Schedule";
    return "Manual";
  }

  /** Signal type badge variant for InlineBadge. */
  function signalVariant(node: TopologyNode): "info" | "warning" | "accent" {
    const provider = node.metadata.provider;
    if (provider === "http") return "info";
    if (provider === "cron") return "warning";
    return "accent";
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
      This workspace uses execution-mode jobs which are not supported in the pipeline view. Migrate
      to FSM-based jobs to see the visual pipeline.
    </p>
  </div>
{:else if compact}
  <div class="pipeline pipeline--compact" role="img" aria-label="Workspace pipeline diagram">
    {#each pipelineNodes as node, i (node.id)}
      {#if i > 0}
        <svg
          class="connector connector--compact"
          width="16"
          height="8"
          viewBox="0 0 16 8"
          aria-hidden="true"
        >
          <line x1="0" y1="4" x2="11" y2="4" stroke="var(--color-border-1)" stroke-width="1" />
          <polygon points="11,1.5 16,4 11,6.5" fill="var(--color-border-1)" />
        </svg>
      {/if}

      <button
        class="pill"
        class:pill--signal={node.type === "signal"}
        class:pill--step={node.type === "agent-step"}
        class:pill--selected={selectedNodeId === node.id}
        class:pill--skipped={nodeStatusMap[node.id] === "skipped"}
        onclick={() => onNodeClick?.(node)}
      >
        {#if nodeStatusMap[node.id]}
          <span
            class="status-dot status-dot--{nodeStatusMap[node.id]}"
            aria-label={nodeStatusMap[node.id]}
          ></span>
        {/if}
        <span
          class="pill-icon"
          class:pill-icon--signal={node.type === "signal"}
          class:pill-icon--step={node.type === "agent-step"}
          aria-hidden="true"
        >
          {#if node.type === "signal"}
            <Icons.Bolt />
          {:else}
            <Icons.RectangleStack />
          {/if}
        </span>
        <span>{node.type === "signal" ? (node.metadata.title ?? node.label) : stepName(node)}</span>
      </button>
    {/each}
  </div>
{:else}
  <div class="pipeline" role="img" aria-label="Workspace pipeline diagram">
    {#each pipelineNodes as node, i (node.id)}
      <!-- Horizontal arrow connector between cards -->
      {#if i > 0}
        {@const prevNode = pipelineNodes[i - 1]}
        {@const connectorDashed =
          (prevNode && prevNode.type === "agent-step" && isDisabled(prevNode)) ||
          (node.type === "agent-step" && isDisabled(node))}
        <svg
          class="connector"
          class:connector--dashed={connectorDashed}
          width="24"
          height="12"
          viewBox="0 0 24 12"
          aria-hidden="true"
        >
          <line
            x1="0"
            y1="6"
            x2="18"
            y2="6"
            stroke="var(--color-border-1)"
            stroke-width="1"
            stroke-dasharray={connectorDashed ? "3 2" : "none"}
          />
          <polygon points="18,2 24,6 18,10" fill="var(--color-border-1)" />
        </svg>
      {/if}

      {#if node.type === "signal"}
        <button
          class="card card--signal"
          class:card--selected={selectedNodeId === node.id}
          onclick={() => onNodeClick?.(node)}
        >
          <InlineBadge variant={signalVariant(node)}>{signalBadge(node)}</InlineBadge>
          <span class="card-label">{node.metadata.title ?? node.label}</span>
        </button>
      {:else if node.type === "agent-step"}
        {@const disabled = isDisabled(node)}
        {#if onToggleStep}
          <div class="step-context-wrapper" class:step--disabled={disabled}>
            <button
              class="card card--step"
              class:card--selected={selectedNodeId === node.id}
              onclick={() => onNodeClick?.(node)}
            >
              <div class="step-header">
                {#if nodeStatusMap[node.id]}
                  <span
                    class="status-dot status-dot--{nodeStatusMap[node.id]}"
                    aria-label={nodeStatusMap[node.id]}
                  ></span>
                {/if}
                <span class="step-name" class:step-name--disabled={disabled}>{stepName(node)}</span>
              </div>
              {#if agentName(node)}
                <span class="agent-name">{agentName(node)}</span>
              {/if}
            </button>
            <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
              <DropdownMenu.Trigger class="step-menu-trigger" aria-label="Step options">
                <Icons.TripleDots />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Item onclick={() => onToggleStep(stateIdFromNode(node))}>
                  {disabled ? "Enable step" : "Disable step"}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        {:else}
          <button
            class="card card--step"
            class:card--selected={selectedNodeId === node.id}
            onclick={() => onNodeClick?.(node)}
          >
            <div class="step-header">
              {#if nodeStatusMap[node.id]}
                <span
                  class="status-dot status-dot--{nodeStatusMap[node.id]}"
                  aria-label={nodeStatusMap[node.id]}
                ></span>
              {/if}
              <span class="step-name">{stepName(node)}</span>
            </div>
            {#if agentName(node)}
              <span class="agent-name">{agentName(node)}</span>
            {/if}
          </button>
        {/if}
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
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 25%);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    font-family: inherit;
    gap: var(--size-1);
    padding: var(--size-2) var(--size-3);
    text-align: start;
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
    padding-inline-end: var(--size-11);
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Compact mode (pill breadcrumb) ---- */

  .pipeline--compact {
    gap: var(--size-1-5);
    padding: 0;
    mask-image: none;
    -webkit-mask-image: none;
  }

  .pill {
    align-items: center;
    background: var(--color-surface-2);
    border: none;
    border-radius: var(--radius-pill, 9999px);
    color: var(--color-text);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    height: 24px;
    line-height: 1;
    gap: var(--size-1);
    padding: 0 var(--size-2);
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease;
    white-space: nowrap;
  }

  .pill--signal {
    border-start-start-radius: var(--radius-1);
    border-end-start-radius: var(--radius-1);
  }

  .pill-icon {
    align-items: center;
    block-size: 16px;
    display: inline-flex;
    inline-size: 16px;
    justify-content: center;
    line-height: 1;
  }

  .pill-icon :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .pill-icon--signal {
    background: color-mix(in srgb, var(--color-info), transparent 80%);
    border-radius: var(--radius-1);
    color: var(--color-info);
  }

  .pill-icon--step {
    background: color-mix(in srgb, var(--color-success), transparent 82%);
    border-radius: 50%;
    color: var(--color-success);
  }

  .pill:hover {
    background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 6%);
  }

  .pill--selected {
    border-color: var(--color-info);
    box-shadow: 0 0 0 1px var(--color-info);
  }

  .pill--skipped {
    opacity: 0.4;
  }

  .connector--compact {
    flex-shrink: 0;
  }

  /* ---- Horizontal arrow connectors ---- */

  .connector {
    flex-shrink: 0;
  }

  .connector--dashed {
    opacity: 0.35;
  }

  /* ---- Step menu wrapper ---- */

  .step-context-wrapper {
    flex-shrink: 0;
    position: relative;
  }

  .step-context-wrapper :global(.step-menu-trigger) {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    cursor: pointer;
    display: flex;
    inset-block-start: var(--size-2);
    inset-inline-end: var(--size-2);
    justify-content: center;
    padding: var(--size-1);
    position: absolute;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }

  .step-context-wrapper :global(.step-menu-trigger:hover),
  .step-context-wrapper :global(.step-menu-trigger[data-state="open"]) {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    color: var(--color-text);
  }

  /* ---- Disabled step treatment ---- */

  .step--disabled .card {
    opacity: 0.35;
  }

  .step-name--disabled {
    text-decoration: line-through;
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    max-inline-size: 360px;
  }

  .unsupported-notice {
    flex-shrink: 0;
    margin-inline-start: var(--size-2);
  }

  .unsupported-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  /* ---- Status dots ---- */

  .status-dot {
    display: inline-block;
    inline-size: 8px;
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot--completed {
    background: var(--color-success, #22c55e);
  }

  .status-dot--running {
    background: var(--color-info, #3b82f6);
    animation: dot-pulse 1.5s ease-in-out infinite;
  }

  .status-dot--failed {
    background: var(--color-error, #ef4444);
  }

  .status-dot--skipped {
    background: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  @keyframes dot-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-dot--running {
      animation: none;
    }
  }
</style>
