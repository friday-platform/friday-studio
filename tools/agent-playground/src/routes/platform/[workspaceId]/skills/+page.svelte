<!--
  Workspace skills page — three disjoint sections driven by the classified
  catalog endpoint (one round-trip, no N+1 assignment lookups):

    • Assigned to this workspace — direct skill_assignments rows
    • Global (unassigned)        — skills with zero assignments, visible everywhere
    • Available to assign here   — skills assigned elsewhere, offered for assignment

  Mutations hit /api/skills/scoping/:skillId/assignments (already wired on
  the daemon) and invalidate `classifiedWorkspaceSkills` + `workspaceSkills`.

  @component
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries } from "$lib/queries";
  import { useAssignSkill, useUnassignSkill } from "$lib/queries/skills";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const classifiedQuery = createQuery(() =>
    skillQueries.classifiedWorkspaceSkills(workspaceId),
  );

  const assignMut = useAssignSkill();
  const unassignMut = useUnassignSkill();

  // Track per-skill pending state so clicking one row doesn't spinner the whole list.
  let pending = $state<Record<string, boolean>>({});

  async function attach(skillId: string) {
    if (!workspaceId) return;
    pending = { ...pending, [skillId]: true };
    try {
      await assignMut.mutateAsync({ skillId, workspaceId });
    } finally {
      const { [skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  async function detach(skillId: string) {
    if (!workspaceId) return;
    pending = { ...pending, [skillId]: true };
    try {
      await unassignMut.mutateAsync({ skillId, workspaceId });
    } finally {
      const { [skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  const assigned = $derived(classifiedQuery.data?.assigned ?? []);
  const global = $derived(classifiedQuery.data?.global ?? []);
  const other = $derived(classifiedQuery.data?.other ?? []);
</script>

<div class="skills-page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  {#if classifiedQuery.isLoading}
    <div class="empty-state"><p>Loading skills...</p></div>
  {:else if classifiedQuery.isError}
    <div class="empty-state"><p>Failed to load skills</p></div>
  {:else}
    <!-- Assigned to this workspace -->
    <section class="section">
      <header>
        <h2>Assigned to this workspace</h2>
        <span class="count">{assigned.length}</span>
      </header>
      {#if assigned.length === 0}
        <p class="empty-hint">No skills directly assigned yet. Attach one below.</p>
      {:else}
        <div class="skill-list">
          {#each assigned as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot assigned"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              <button
                type="button"
                class="row-action detach"
                disabled={pending[skill.skillId]}
                onclick={() => detach(skill.skillId)}
              >
                Detach
              </button>
              {#if skill.description}
                <p class="row-description">{skill.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Global (unassigned, auto-visible) -->
    <section class="section">
      <header>
        <h2>Global (auto-visible)</h2>
        <span class="count">{global.length}</span>
      </header>
      {#if global.length === 0}
        <p class="empty-hint">No global skills. Skills with zero assignments appear here.</p>
      {:else}
        <div class="skill-list">
          {#each global as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot global"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              <span class="row-tag">visible to all workspaces</span>
              {#if skill.description}
                <p class="row-description">{skill.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Available to assign here (currently elsewhere) -->
    <section class="section">
      <header>
        <h2>Available to assign here</h2>
        <span class="count">{other.length}</span>
      </header>
      {#if other.length === 0}
        <p class="empty-hint">No other skills. Import via skills.sh or create a new one.</p>
      {:else}
        <div class="skill-list">
          {#each other as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot other"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              <button
                type="button"
                class="row-action attach"
                disabled={pending[skill.skillId]}
                onclick={() => attach(skill.skillId)}
              >
                Attach
              </button>
              {#if skill.description}
                <p class="row-description">{skill.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .skills-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section > header {
    align-items: baseline;
    display: flex;
    gap: var(--size-3);
  }

  .section h2 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .count {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    margin: 0;
    padding-block-start: var(--size-2);
  }

  .skill-list {
    display: flex;
    flex-direction: column;
  }

  .skill-row {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    column-gap: var(--size-3);
    display: grid;
    grid-template-columns: 1fr auto;
    padding: var(--size-3) var(--size-1);
    position: relative;
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

  .skill-row:hover::before {
    opacity: 1;
  }

  .row-main {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-3);
    text-decoration: none;
  }

  .skill-dot {
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .skill-dot.assigned {
    background-color: var(--color-success);
  }

  .skill-dot.global {
    background-color: var(--color-primary, #7a9cf0);
  }

  .skill-dot.other {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .skill-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .row-action {
    background-color: transparent;
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-3);
    transition: background-color 120ms ease;
  }

  .row-action:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
  }

  .row-action:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .row-action.detach:hover:not(:disabled) {
    border-color: var(--color-error, #dc5c5c);
    color: var(--color-error, #dc5c5c);
  }

  .row-tag {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-0);
    justify-self: end;
  }

  .row-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    grid-column: 1 / -1;
    line-height: 1.4;
    margin: 0;
    overflow: hidden;
    padding-block-start: var(--size-1);
    padding-inline-start: calc(8px + var(--size-3));
  }
</style>
