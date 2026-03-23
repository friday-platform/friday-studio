<!--
  Collapsible section with disclosure triangle, animated expand/collapse,
  and localStorage persistence. Shared wrapper for below-pipeline panels
  (Data Contracts, Signals, etc.).

  @component
  @param {string} title - Section heading (e.g. "DATA CONTRACTS")
  @param {string} summaryText - Compact badge text visible in both states (e.g. "3 types")
  @param {string} sectionKey - Unique key for localStorage persistence
  @param {string} workspaceId - Workspace ID for scoped localStorage key
  @param {boolean} [defaultExpanded=true] - Initial state when no localStorage entry exists
-->

<script lang="ts">
  import type { Snippet } from "svelte";
  import { readSectionState, writeSectionState } from "$lib/collapsible-state";

  type Props = {
    title: string;
    summaryText: string;
    sectionKey: string;
    workspaceId: string;
    defaultExpanded?: boolean;
    children?: Snippet;
  };

  let {
    title,
    summaryText,
    sectionKey,
    workspaceId,
    defaultExpanded = true,
    children,
  }: Props = $props();

  let expanded = $state(true);

  /** Initialize from localStorage on mount and when key changes. */
  $effect(() => {
    expanded = readSectionState(workspaceId, sectionKey, defaultExpanded);
  });

  /** Persist to localStorage on toggle. */
  function toggle() {
    expanded = !expanded;
    writeSectionState(workspaceId, sectionKey, expanded);
  }
</script>

<section class="collapsible-section">
  <button class="section-header" onclick={toggle} aria-expanded={expanded}>
    <span class="disclosure">{expanded ? "\u25BE" : "\u25B8"}</span>
    <span class="section-title">{title}</span>
    <span class="section-summary">{summaryText}</span>
  </button>
  <div class="section-body" class:section-body--expanded={expanded}>
    {#if children}
      {@render children()}
    {/if}
  </div>
</section>

<style>
  .collapsible-section {
    display: flex;
    flex-direction: column;
  }

  .section-header {
    align-items: center;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-4);
    text-align: start;
    transition: background-color 150ms ease;
  }

  .section-header:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .disclosure {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    inline-size: 1em;
    line-height: 1;
  }

  .section-title {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .section-summary {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    margin-inline-start: auto;
  }

  .section-body {
    max-block-size: 0;
    overflow: hidden;
    transition: max-block-size 250ms ease;
  }

  .section-body--expanded {
    max-block-size: 1000px;
  }
</style>
