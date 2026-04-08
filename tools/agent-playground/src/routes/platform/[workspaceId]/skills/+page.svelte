<!--
  Workspace skills page — shows skills visible to this workspace
  (resolved via global visibility, direct assignments, and collections).

  @component
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries } from "$lib/queries";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const skillsQuery = createQuery(() => skillQueries.workspaceSkills(workspaceId));

  interface SkillSummary {
    skillId: string;
    namespace: string;
    name: string | null;
    description: string;
  }

  const skills = $derived((skillsQuery.data ?? []) as SkillSummary[]);
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
  {:else if skills.length === 0}
    <div class="empty-state">
      <p>No skills visible to this workspace</p>
      <span class="empty-hint">Assign skills or collections via the API</span>
    </div>
  {:else}
    <div class="skill-list">
      {#each skills as skill (skill.skillId)}
        <a class="skill-row" href="/skills/{skill.namespace}/{skill.name}">
          <div class="row-main">
            <span class="skill-dot"></span>
            <span class="skill-name">{skill.namespace}/{skill.name}</span>
          </div>
          {#if skill.description}
            <p class="row-description">{skill.description}</p>
          {/if}
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .skills-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
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

  .skill-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .row-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
    overflow: hidden;
    padding-inline-start: calc(8px + var(--size-3));
  }
</style>
