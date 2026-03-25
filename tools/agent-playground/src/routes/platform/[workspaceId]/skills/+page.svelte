<!--
  Workspace skills bindings page — read-only view of which skills are bound
  to this workspace. "Add Skill" opens a search picker to bind catalog skills.
  Catalog skills link to the global editor; inline skills show instructions
  read-only. Remove button unbinds from workspace.yml.

  @component
-->

<script lang="ts">
  import { DropdownMenu } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries } from "$lib/queries";
  import {
    useAddWorkspaceSkill,
    useRemoveWorkspaceSkill,
    type CatalogSkill,
  } from "$lib/queries/skills";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const skillsQuery = createQuery(() => skillQueries.workspaceSkills(workspaceId));
  const catalogQuery = createQuery(() => skillQueries.catalog());
  const removeMutation = useRemoveWorkspaceSkill(() => workspaceId);
  const addMutation = useAddWorkspaceSkill(() => workspaceId);

  const globalRefs = $derived(skillsQuery.data?.globalRefs ?? []);
  const inlineSkills = $derived(skillsQuery.data?.inlineSkills ?? []);
  const hasSkills = $derived(globalRefs.length > 0 || inlineSkills.length > 0);

  /** Lookup catalog skill metadata by @ns/name ref */
  const catalogByRef = $derived.by((): Map<string, CatalogSkill> => {
    const map = new Map<string, CatalogSkill>();
    for (const s of catalogQuery.data ?? []) {
      map.set(`@${s.namespace}/${s.name}`, s);
    }
    return map;
  });

  // ---------------------------------------------------------------------------
  // Picker state
  // ---------------------------------------------------------------------------

  let pickerOpen = $state(false);
  let searchQuery = $state("");

  /** Set of `@ns/name` refs already bound to filter out of picker results */
  const boundRefs = $derived(new Set(globalRefs.map((r) => r.ref)));

  /** Catalog skills not already bound, filtered by search query */
  const availableSkills = $derived.by((): CatalogSkill[] => {
    const all = catalogQuery.data ?? [];
    const q = searchQuery.toLowerCase().trim();
    return all.filter((s) => {
      const ref = `@${s.namespace}/${s.name ?? ""}`;
      if (boundRefs.has(ref)) return false;
      if (s.disabled) return false;
      if (!q) return true;
      return (
        ref.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q)
      );
    });
  });

  function openPicker() {
    searchQuery = "";
    pickerOpen = true;
  }

  function closePicker() {
    pickerOpen = false;
  }

  function handleBind(skill: CatalogSkill) {
    const ref = `@${skill.namespace}/${skill.name}`;
    addMutation.mutate(ref, {
      onSuccess: () => {
        closePicker();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Inline expand
  // ---------------------------------------------------------------------------

  let expandedInline = $state<string | null>(null);

  function toggleInline(name: string) {
    expandedInline = expandedInline === name ? null : name;
  }

  function handleRemove(skillName: string) {
    removeMutation.mutate(skillName);
  }

  /** Open picker when navigated with ?addSkill query param (from sidebar button). */
  $effect(() => {
    if (page.url.searchParams.has("addSkill")) {
      openPicker();
      goto(page.url.pathname, { replaceState: true });
    }
  });
</script>

<div class="skills-page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  {#if skillsQuery.isLoading}
    <div class="empty-state">
      <p>Loading skills...</p>
    </div>
  {:else if skillsQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace skills</p>
    </div>
  {:else if !hasSkills}
    <div class="empty-state">
      <p>No skills bound</p>
      <span class="empty-hint">Add skills to your workspace.yml or use the button below</span>
      <button class="add-btn" onclick={openPicker}>Add Skill</button>
    </div>
  {:else}
    <div class="skill-list">
      {#each globalRefs as ref (ref.ref)}
        {@const catalogMeta = catalogByRef.get(ref.ref)}
        <a class="skill-row" href="/skills/{ref.namespace}/{ref.name}">
          <div class="row-main">
            <span class="skill-dot"></span>
            <span class="skill-name">{ref.namespace}/{ref.name}</span>
            <span class="type-badge catalog">CATALOG</span>
            {#if ref.version !== undefined}
              <span class="version-badge">v{ref.version}</span>
            {/if}
            <div class="row-actions" onclick={(e) => e.preventDefault()}>
              <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
                {#snippet children()}
                  <DropdownMenu.Trigger class="overflow-trigger" aria-label="Skill options">
                    <span class="overflow-btn">&hellip;</span>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Content>
                    <DropdownMenu.Item
                      disabled={removeMutation.isPending}
                      onclick={() => handleRemove(ref.ref)}
                    >
                      {removeMutation.isPending ? "Removing..." : "Remove from workspace"}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                {/snippet}
              </DropdownMenu.Root>
            </div>
          </div>
          {#if catalogMeta?.description}
            <p class="row-description">{catalogMeta.description}</p>
          {/if}
        </a>
      {/each}

      {#each inlineSkills as skill (skill.name)}
        <div class="skill-row">
          <div class="row-main">
            <span class="skill-dot inline"></span>
            <span class="skill-name">{skill.name}</span>
            <span class="type-badge inline">INLINE</span>
            <div class="row-actions">
              <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
                {#snippet children()}
                  <DropdownMenu.Trigger class="overflow-trigger" aria-label="Skill options">
                    <span class="overflow-btn">&hellip;</span>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Content>
                    <DropdownMenu.Item onclick={() => toggleInline(skill.name)}>
                      {expandedInline === skill.name ? "Hide instructions" : "View instructions"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={removeMutation.isPending}
                      onclick={() => handleRemove(skill.name)}
                    >
                      {removeMutation.isPending ? "Removing..." : "Remove from workspace"}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                {/snippet}
              </DropdownMenu.Root>
            </div>
          </div>
          {#if skill.description}
            <p class="row-description">{skill.description}</p>
          {/if}
        </div>

        {#if expandedInline === skill.name}
          <pre class="instructions-block">{skill.instructions}</pre>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<!-- Picker overlay -->
{#if pickerOpen}
  <div class="picker-backdrop" onclick={closePicker} role="presentation"></div>
  <div class="picker-panel">
    <div class="picker-header">
      <h2>Add Skill</h2>
      <button class="picker-close" onclick={closePicker}>&times;</button>
    </div>
    <input
      class="picker-search"
      type="text"
      placeholder="Search catalog skills..."
      bind:value={searchQuery}
    />
    <div class="picker-results">
      {#if catalogQuery.isLoading}
        <p class="picker-empty">Loading catalog...</p>
      {:else if availableSkills.length === 0}
        <p class="picker-empty">
          {searchQuery ? "No matching skills" : "All catalog skills are already bound"}
        </p>
      {:else}
        {#each availableSkills as skill (`@${skill.namespace}/${skill.name}`)}
          <button
            class="picker-item"
            disabled={addMutation.isPending}
            onclick={() => handleBind(skill)}
          >
            <span class="picker-item-name">@{skill.namespace}/{skill.name}</span>
            {#if skill.description}
              <span class="picker-item-desc">{skill.description}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .skills-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  /* --- Empty state --------------------------------------------------------- */

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .empty-hint {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .add-btn {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-2);
    margin-block-start: var(--size-3);
    padding: var(--size-2) var(--size-4);
    transition: background-color 100ms ease;
  }

  .add-btn:hover {
    background-color: var(--color-highlight-1);
  }

  /* --- Skill list & rows --------------------------------------------------- */

  .skill-list {
    display: flex;
    flex-direction: column;
  }

  .skill-row {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-3) var(--size-1);
    position: relative;
    text-decoration: none;
    transition: border-color 250ms ease;
    z-index: 1;
  }

  .skill-row::before {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-4);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .skill-row:hover {
    border-color: transparent;
  }

  .skill-row:hover::before {
    opacity: 1;
  }

  .skill-row:has(+ .skill-row:hover) {
    border-color: transparent;
  }

  .row-main {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .skill-dot {
    background-color: var(--color-success);
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .skill-dot.inline {
    background-color: var(--color-info);
  }

  .skill-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .type-badge {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
  }

  .type-badge.catalog {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    color: var(--color-success);
  }

  .type-badge.inline {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .version-badge {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .row-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
    overflow: hidden;
    padding-inline-start: calc(8px + var(--size-3));
  }

  /* --- Overflow menu ------------------------------------------------------- */

  .row-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    margin-inline-start: auto;
  }

  .row-actions :global(.overflow-trigger) {
    border-radius: var(--radius-2);
  }

  .overflow-btn {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    line-height: 1;
    padding: var(--size-1) var(--size-2);
  }

  :global(.overflow-trigger):hover .overflow-btn {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  /* --- Instructions block -------------------------------------------------- */

  .instructions-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: 1.6;
    margin: 0;
    margin-block-end: var(--size-2);
    max-block-size: 400px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ========================================================================= */
  /* Picker overlay                                                            */
  /* ========================================================================= */

  .picker-backdrop {
    background: rgba(0, 0, 0, 0.4);
    inset: 0;
    position: fixed;
    z-index: 100;
  }

  .picker-panel {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inset-block-start: 50%;
    inset-inline-start: 50%;
    max-block-size: 70vh;
    max-inline-size: 500px;
    padding: var(--size-5) var(--size-6);
    position: fixed;
    transform: translate(-50%, -50%);
    inline-size: 90vw;
    z-index: 101;
  }

  .picker-header {
    align-items: center;
    display: flex;
    justify-content: space-between;

    h2 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }
  }

  .picker-close {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    cursor: pointer;
    font-size: var(--font-size-5);
    line-height: 1;
  }

  .picker-close:hover {
    color: var(--color-text);
  }

  .picker-search {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease;
  }

  .picker-search:focus {
    border-color: var(--color-info);
    outline: none;
  }

  .picker-results {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    overflow-y: auto;
  }

  .picker-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding: var(--size-4) 0;
    text-align: center;
  }

  .picker-item {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-3);
    text-align: start;
    transition:
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .picker-item:hover:not(:disabled) {
    background-color: var(--color-surface-2);
    border-color: var(--color-border-1);
  }

  .picker-item:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .picker-item-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .picker-item-desc {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    line-height: 1.4;
    overflow: hidden;
  }
</style>
