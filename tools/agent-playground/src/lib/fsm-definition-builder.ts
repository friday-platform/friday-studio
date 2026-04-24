/**
 * Transforms an FSM definition into a Mermaid `flowchart TD` string with
 * entry action subgraphs and execution state highlighting.
 *
 * Pure function — no side effects, no DOM, fully unit-testable.
 *
 * @module
 */

import type { Action, FSMDefinition } from "@atlas/fsm-engine";

/**
 * Options for execution state highlighting.
 *
 * @property activeState - The currently active state (gets `active` class)
 * @property visitedStates - States that have been visited (get `visited` class)
 */
export interface BuildFSMOptions {
  activeState?: string;
  visitedStates?: Set<string>;
}

/** Sanitize a state name for Mermaid (hyphens break parsing). */
function mermaidId(name: string): string {
  return name.replace(/-/g, "_");
}

/** Build a display label for an entry action node. */
function actionLabel(action: Action): string {
  switch (action.type) {
    case "llm":
      return `AI: ${action.model}`;
    case "agent":
      return `agent: ${action.agentId}`;
    case "emit":
      return `emit ${action.event}`;
  }
}

/** Map action type to its Mermaid classDef name. */
function actionClass(action: Action): string {
  switch (action.type) {
    case "llm":
      return "llmAction";
    case "agent":
      return "agentAction";
    case "emit":
      return "emitSignal";
  }
}

/**
 * Build a Mermaid `flowchart TD` definition from an FSM definition.
 *
 * Produces START/STOP nodes, state nodes with labels, transition edges,
 * entry action subgraphs, classDef declarations, and optional execution
 * state highlighting.
 *
 * @param fsm - The FSM definition (states + transitions)
 * @param options - Optional execution state highlighting
 * @returns Mermaid flowchart TD definition string
 */
export function buildFSMDefinition(
  fsm: Pick<FSMDefinition, "initial" | "states">,
  options?: BuildFSMOptions,
): string {
  const lines: string[] = ["flowchart TD"];
  const stateNames = Object.keys(fsm.states);

  // START node + edge to initial state
  lines.push(`    START(( )) --> ${mermaidId(fsm.initial)}`);
  lines.push("");

  // State nodes, transitions, and final edges
  for (const name of stateNames) {
    const def = fsm.states[name];
    if (!def) continue;
    const id = mermaidId(name);

    // State node with label
    lines.push(`    ${id}["${name}"]`);

    // Final state edge to STOP
    if (def.type === "final") {
      lines.push(`    ${id} --> STOP(( ))`);
    }

    // Transitions — guard against `on` being boolean (YAML 1.1 coercion)
    if (def.on && typeof def.on === "object") {
      for (const [signal, transitionDef] of Object.entries(def.on)) {
        const defs = Array.isArray(transitionDef) ? transitionDef : [transitionDef];
        for (const t of defs) {
          lines.push(`    ${id} -->|"${signal}"| ${mermaidId(t.target)}`);
        }
      }
    }
  }

  // Entry action subgraphs
  for (const name of stateNames) {
    const def = fsm.states[name];
    if (!def || !def.entry || def.entry.length === 0) continue;

    const id = mermaidId(name);
    const subgraphId = `${id}_actions`;

    lines.push("");
    lines.push(`    subgraph ${subgraphId} [" "]`);
    lines.push("        direction TB");

    // Action nodes
    for (let i = 0; i < def.entry.length; i++) {
      const action = def.entry[i];
      if (!action) continue;
      const nodeId = `${id}_a${i}`;
      lines.push(`        ${nodeId}["${actionLabel(action)}"]:::${actionClass(action)}`);
    }

    // Chain action nodes sequentially
    if (def.entry.length > 1) {
      const chain = def.entry.map((_, i) => `${id}_a${i}`).join(" --> ");
      lines.push(`        ${chain}`);
    }

    lines.push("    end");

    // Dotted edge from state to subgraph
    lines.push(`    ${id} -.-> ${subgraphId}`);
  }

  // ClassDef declarations — action types
  lines.push("");
  lines.push("    classDef llmAction fill:#3b82f6,stroke:#2563eb,color:#fff");
  lines.push("    classDef agentAction fill:#22c55e,stroke:#16a34a,color:#fff");
  lines.push("    classDef emitSignal fill:#6b7280,stroke:#4b5563,color:#fff,stroke-dasharray:5 5");

  // ClassDef declarations — execution state
  lines.push("    classDef active fill:#3b82f6,stroke:#2563eb,color:#fff,stroke-width:3px");
  lines.push("    classDef visited fill:#22c55e,stroke:#16a34a,color:#fff,stroke-width:2px");
  lines.push("    classDef unvisited fill:#374151,stroke:#4b5563,color:#9ca3af,stroke-width:1px");

  // Apply execution state classes (only when options provided)
  if (options?.activeState || options?.visitedStates) {
    lines.push("");
    for (const name of stateNames) {
      const id = mermaidId(name);
      if (name === options.activeState) {
        lines.push(`    class ${id} active`);
      } else if (options.visitedStates?.has(name)) {
        lines.push(`    class ${id} visited`);
      } else {
        lines.push(`    class ${id} unvisited`);
      }
    }
  }

  return lines.join("\n");
}
