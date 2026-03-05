<script lang="ts">
  /**
   * FSM state diagram hero section.
   *
   * Renders an FSM definition as a Mermaid `flowchart TD` via beautiful-mermaid
   * with entry action subgraphs, dot-grid canvas background, and zoom controls.
   * Reads execution state from `ExecutionState` context to synchronize diagram
   * highlighting with the drawer stepper position.
   *
   * @component
   * @param {FSMDefinition} fsm - The FSM definition (states + transitions)
   */

  import type { FSMDefinition } from "@atlas/fsm-engine";
  import { useExecutionState } from "$lib/execution-context.svelte.ts";
  import { buildFSMDefinition } from "$lib/fsm-definition-builder.ts";
  import { renderDiagram } from "$lib/render-mermaid.ts";

  type Props = { fsm: FSMDefinition };

  let { fsm }: Props = $props();

  const execution = useExecutionState();

  // ---------------------------------------------------------------------------
  // Zoom / pan state
  // ---------------------------------------------------------------------------

  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 3;

  let scale = $state(1);
  let translateX = $state(0);
  let translateY = $state(0);

  /** Pointer-drag tracking for panning */
  let dragging = $state(false);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragOriginX = $state(0);
  let dragOriginY = $state(0);

  function zoomIn() {
    scale = Math.min(scale + ZOOM_STEP, ZOOM_MAX);
  }

  function zoomOut() {
    scale = Math.max(scale - ZOOM_STEP, ZOOM_MIN);
  }

  function fitToView() {
    scale = 1;
    translateX = 0;
    translateY = 0;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOriginX = translateX;
    dragOriginY = translateY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    translateX = dragOriginX + (e.clientX - dragStartX);
    translateY = dragOriginY + (e.clientY - dragStartY);
  }

  function onPointerUp() {
    dragging = false;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomIn();
    } else {
      zoomOut();
    }
  }

  // ---------------------------------------------------------------------------
  // Execution-synced highlighting (reads from ExecutionState context)
  // ---------------------------------------------------------------------------

  /** Whether there is execution data to highlight. */
  const hasExecution = $derived(execution.transitions.length > 0);

  /** Active state derived from execution context stepper position. */
  const activeState = $derived(execution.activeState);

  /** Visited states derived from execution context stepper position. */
  const visitedStates = $derived(execution.visitedStates);

  /** Set of traversed edges as "from->to" strings for DOM marking. */
  const traversedEdges = $derived.by(() => {
    const edges = new Set<string>();
    for (let i = 0; i <= execution.stepIndex; i++) {
      const t = execution.transitions[i];
      if (t) edges.add(`${t.from}->${t.to}`);
    }
    return edges;
  });

  // ---------------------------------------------------------------------------
  // Mermaid definition + SVG rendering
  // ---------------------------------------------------------------------------

  const mermaidDefinition = $derived.by(() => {
    return buildFSMDefinition(
      fsm,
      hasExecution ? { activeState: activeState ?? undefined, visitedStates } : undefined,
    );
  });

  const diagramSvg = $derived(renderDiagram(mermaidDefinition));

  /** Reference to the diagram container for edge DOM manipulation. */
  let diagramEl = $state<HTMLDivElement | null>(null);

  /** Mark traversed edges in the SVG DOM with a `data-traversed` attribute. */
  $effect(() => {
    if (!diagramEl || !hasExecution) return;
    const edges = diagramEl.querySelectorAll<SVGPolylineElement>("polyline.edge");
    for (const edge of edges) {
      const from = edge.getAttribute("data-from") ?? "";
      const to = edge.getAttribute("data-to") ?? "";
      const key = `${from}->${to}`;
      if (traversedEdges.has(key)) {
        edge.setAttribute("data-traversed", "true");
      } else {
        edge.removeAttribute("data-traversed");
      }
    }
  });
</script>

<div class="fsm-hero">
  <div
    class="fsm-canvas"
    class:dragging
    class:has-execution={hasExecution}
    class:is-running={execution.isRunning}
    role="img"
    aria-label="FSM state diagram"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
  >
    {#if diagramSvg}
      <div
        bind:this={diagramEl}
        class="diagram-transform"
        style="transform: translate({translateX}px, {translateY}px) scale({scale})"
      >
        {@html diagramSvg}
      </div>
    {/if}

    <div class="zoom-controls" onpointerdown={(e) => e.stopPropagation()}>
      <button class="zoom-btn" onclick={zoomIn} aria-label="Zoom in">+</button>
      <button class="zoom-btn" onclick={zoomOut} aria-label="Zoom out">&minus;</button>
      <button class="zoom-btn zoom-btn--fit" onclick={fitToView} aria-label="Fit to view">
        Fit
      </button>
    </div>

    <div class="legend">
      <span class="legend-item">
        <span class="legend-swatch legend-swatch--fn"></span>
        fn
      </span>
      <span class="legend-item">
        <span class="legend-swatch legend-swatch--ai"></span>
        AI
      </span>
      <span class="legend-item">
        <span class="legend-swatch legend-swatch--agent"></span>
        agent
      </span>
      <span class="legend-item">
        <span class="legend-swatch legend-swatch--emit"></span>
        emit
      </span>
    </div>
  </div>
</div>

<style>
  .fsm-hero {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .fsm-canvas {
    background-color: var(--color-surface-1);
    background-image: radial-gradient(
      circle,
      color-mix(in srgb, var(--color-border-1), transparent 50%) 1px,
      transparent 1px
    );
    background-size: 24px 24px;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    cursor: grab;
    min-block-size: 300px;
    overflow: hidden;
    padding: var(--size-4);
    position: relative;
    transition:
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }

  .fsm-canvas.dragging {
    cursor: grabbing;
  }

  .diagram-transform {
    display: flex;
    justify-content: center;
    transform-origin: center center;
    transition: transform 0.15s ease;
  }

  .fsm-canvas.dragging .diagram-transform {
    transition: none;
  }

  .diagram-transform :global(svg) {
    max-inline-size: 100%;
  }

  /* ---- Execution highlighting ---- */

  /* Active state: breathing glow animation */
  @keyframes active-glow {
    0%,
    100% {
      filter: drop-shadow(0 0 4px rgba(59, 130, 246, 0.4));
    }
    50% {
      filter: drop-shadow(0 0 12px rgba(59, 130, 246, 0.8));
    }
  }

  .fsm-canvas.has-execution .diagram-transform :global(.node.active rect),
  .fsm-canvas.has-execution .diagram-transform :global(.node.active polygon),
  .fsm-canvas.has-execution .diagram-transform :global(.node.active circle) {
    animation: active-glow 2s ease-in-out infinite;
  }

  /* Visited state nodes: green tint */
  .fsm-canvas.has-execution .diagram-transform :global(.node.visited rect),
  .fsm-canvas.has-execution .diagram-transform :global(.node.visited polygon),
  .fsm-canvas.has-execution .diagram-transform :global(.node.visited circle) {
    filter: drop-shadow(0 0 3px rgba(34, 197, 94, 0.4));
  }

  /* Unvisited state nodes: dim */
  .fsm-canvas.has-execution .diagram-transform :global(.node.unvisited rect),
  .fsm-canvas.has-execution .diagram-transform :global(.node.unvisited polygon),
  .fsm-canvas.has-execution .diagram-transform :global(.node.unvisited circle) {
    opacity: 0.5;
  }

  /* ---- Edge traversal animation ---- */

  /* All edges dim during execution */
  .fsm-canvas.has-execution .diagram-transform :global(polyline.edge) {
    opacity: 0.3;
    transition:
      opacity 0.3s ease,
      stroke 0.3s ease;
  }

  /* Traversed edges: green stroke + animated dash offset */
  .fsm-canvas.has-execution .diagram-transform :global(polyline.edge[data-traversed="true"]) {
    animation: edge-flow 1s ease-out both;
    opacity: 1;
    stroke: #22c55e;
    stroke-dasharray: 8 4;
  }

  @keyframes edge-flow {
    from {
      stroke-dashoffset: 24;
    }
    to {
      stroke-dashoffset: 0;
    }
  }

  /* During live execution: breathing canvas border */
  @keyframes canvas-pulse {
    0%,
    100% {
      border-color: rgba(59, 130, 246, 0.3);
      box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.1);
    }
    50% {
      border-color: rgba(59, 130, 246, 0.5);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
  }

  .fsm-canvas.is-running {
    animation: canvas-pulse 3s ease-in-out infinite;
  }

  /* ---- Zoom controls ---- */

  .zoom-controls {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    position: absolute;
    right: var(--size-3);
    top: var(--size-3);
  }

  .zoom-btn {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    block-size: var(--size-6);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    inline-size: var(--size-6);
    justify-content: center;
    transition: background 0.15s ease;
  }

  .zoom-btn:hover {
    background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 8%);
  }

  .zoom-btn--fit {
    font-family: var(--font-family-sans);
    font-size: var(--font-size-1);
    inline-size: auto;
    padding-inline: var(--size-2);
  }

  /* ---- Legend ---- */

  .legend {
    bottom: var(--size-3);
    display: flex;
    gap: var(--size-3);
    left: var(--size-3);
    position: absolute;
  }

  .legend-item {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
  }

  .legend-swatch {
    block-size: 8px;
    border-radius: 2px;
    display: block;
    inline-size: 8px;
  }

  .legend-swatch--fn {
    background: #d97706;
  }

  .legend-swatch--ai {
    background: #3b82f6;
  }

  .legend-swatch--agent {
    background: #22c55e;
  }

  .legend-swatch--emit {
    background: #6b7280;
  }
</style>
