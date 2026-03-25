<!--
  Renders any JSON-serializable value as a collapsible tree.

  Displays objects and arrays as expandable nodes with type-colored leaf values.
  Supports configurable default expansion depth.

  @component
  @param {unknown} data - Any JSON-serializable value
  @param {number} [defaultExpanded=1] - Depth to auto-expand (1 = top-level keys visible)
-->

<script lang="ts" module>
  /** Returns the JSON type label for a value. */
  function jsonType(value: unknown): "string" | "number" | "boolean" | "null" | "array" | "object" {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    switch (typeof value) {
      case "string":
        return "string";
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      default:
        return "object";
    }
  }

  /** Generates a collapsed inline preview for objects. */
  function objectPreview(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, 3);
    const parts = shown.map((k) => {
      const v = obj[k];
      const t = jsonType(v);
      if (t === "object") return `${k}: {…}`;
      if (t === "array") return `${k}: […]`;
      return k;
    });
    const suffix = keys.length > 3 ? ", …" : "";
    return `{ ${parts.join(", ")}${suffix} }`;
  }
</script>

<script lang="ts">
  import JsonTree from "./json-tree.svelte";

  type Props = {
    data: unknown;
    defaultExpanded?: number;
    /** Internal: current nesting depth. Do not set externally. */
    _depth?: number;
  };

  let { data, defaultExpanded = 1, _depth = 0 }: Props = $props();

  const type = $derived(jsonType(data));
  const isExpandable = $derived(type === "object" || type === "array");

  const autoExpanded = $derived(_depth < defaultExpanded);
  let userToggled: boolean | null = $state(null);
  const expanded = $derived(userToggled !== null ? userToggled : autoExpanded);

  function toggle() {
    userToggled = !expanded;
  }

  // Derived data for expandable types
  const entries = $derived.by((): Array<{ key: string; value: unknown }> => {
    if (type === "array" && Array.isArray(data)) {
      return data.map((v, i) => ({ key: String(i), value: v }));
    }
    if (type === "object" && data !== null && typeof data === "object") {
      return Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
        key: k,
        value: v,
      }));
    }
    return [];
  });

  const bracket = $derived(
    type === "array" ? { open: "[", close: "]" } : { open: "{", close: "}" },
  );
  const summary = $derived.by(() => {
    if (type === "array" && Array.isArray(data)) return `Array(${data.length})`;
    if (type === "object" && data !== null && typeof data === "object") {
      return objectPreview(data as Record<string, unknown>);
    }
    return "";
  });

  /** Format a leaf value for display. */
  function formatValue(val: unknown): string {
    if (val === null) return "null";
    if (typeof val === "string") {
      return `"${val}"`;
    }
    return String(val);
  }
</script>

{#if isExpandable}
  <span class="node">
    <button class="toggle" onclick={toggle} aria-expanded={expanded}>
      <span class="caret" class:caret-expanded={expanded}>&#9662;</span>
      <span class="bracket">{bracket.open}</span>
      {#if !expanded}
        <span class="preview">{summary}</span>
        <span class="bracket">{bracket.close}</span>
      {/if}
    </button>
    {#if expanded}
      <div class="children">
        {#each entries as entry (entry.key)}
          <div class="entry">
            <span class="key">
              {type === "array" ? entry.key : entry.key}
              <span class="colon">:</span>
            </span>
            <JsonTree data={entry.value} {defaultExpanded} _depth={_depth + 1} />
          </div>
        {/each}
      </div>
      <span class="bracket">{bracket.close}</span>
    {/if}
  </span>
{:else}
  <span class="leaf leaf-{type}">{formatValue(data)}</span>
{/if}

<style>
  .node {
    display: flex;
    flex-direction: column;
  }

  .toggle {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    gap: var(--size-1);
    line-height: var(--font-lineheight-3);
    padding: 0;
    text-align: start;
  }

  .toggle:hover {
    opacity: 0.8;
  }

  .caret {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: inline-block;
    flex-shrink: 0;
    font-size: 10px;
    transform: rotate(-90deg);
    transition: transform 150ms ease;
  }

  .caret-expanded {
    transform: rotate(0deg);
  }

  .bracket {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .preview {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .children {
    border-inline-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    display: flex;
    flex-direction: column;
    margin-inline-start: var(--size-2);
    padding-inline-start: var(--size-3);
  }

  .entry {
    align-items: baseline;
    display: flex;
    gap: var(--size-1-5);
    line-height: var(--font-lineheight-3);
  }

  .key {
    color: var(--blue-3);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .colon {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  /* Leaf value colors — subtle tints, not a Christmas tree */

  .leaf {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .leaf-string {
    color: var(--green-3);
  }

  .leaf-number {
    color: var(--yellow-3);
  }

  .leaf-boolean {
    color: var(--purple-3);
  }

  .leaf-null {
    color: var(--purple-3);
    font-style: italic;
  }
</style>
