<!--
  Job detail page — scoping surface for job-level skill assignments.

  Four sections:
    • Workspace-inherited (read-only) — resolveVisibleSkills for the ws
    • Job-specific (editable)         — rows pinned to (ws, jobName)
    • @friday/* (read-only)            — always-available bypass set
    • Available to attach              — catalog candidates not yet visible

  Mutations go through the scoping API:
    POST /skills/scoping/:skillId/assignments
      body: { assignments: [{ workspaceId, jobName }] }

  Read-only sections are intentionally clickable — navigation stays inside
  this workspace so the user can audit which layer owns a skill.

  @component
-->

<script lang="ts">
  import { toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries, workspaceQueries } from "$lib/queries";
  import { useAssignSkill, useUnassignSkill } from "$lib/queries/skills";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const jobName = $derived(page.params.jobName ?? null);

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const jobSkillsQuery = createQuery(() => skillQueries.jobSkills(workspaceId, jobName));

  const assignMut = useAssignSkill();
  const unassignMut = useUnassignSkill();

  const jobTitle = $derived.by(() => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return jobName ?? "Job";
    const job = (cfg.jobs as Record<string, { title?: string; description?: string }> | undefined)?.[
      jobName
    ];
    return job?.title ?? jobName;
  });

  const jobDescription = $derived.by(() => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return null;
    const job = (cfg.jobs as Record<string, { title?: string; description?: string }> | undefined)?.[
      jobName
    ];
    return job?.description ?? null;
  });

  const yamlDeclared = $derived.by((): string[] => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return [];
    const job = (cfg.jobs as Record<string, { skills?: string[] }> | undefined)?.[jobName];
    return Array.isArray(job?.skills) ? job.skills : [];
  });

  // Dual-assignment warning — a skill shouldn't need a job-level row if a
  // workspace-level row already covers it (additive model: the workspace
  // layer already makes it visible to this job). Non-blocking; we still
  // let the user save.
  const workspaceInheritedIds = $derived(
    new Set((jobSkillsQuery.data?.workspaceInherited ?? []).map((s) => s.skillId)),
  );

  let pending = $state<Record<string, boolean>>({});

  async function attach(skillId: string) {
    if (!workspaceId || !jobName) return;
    if (workspaceInheritedIds.has(skillId)) {
      toast({
        title: "Already inherited",
        description: "This skill is workspace-level — it already applies to every job.",
      });
    }
    pending = { ...pending, [skillId]: true };
    try {
      await assignMut.mutateAsync({ skillId, workspaceId, jobName });
      toast({ title: "Attached to job", description: `Scoped to ${jobName}.` });
    } catch (e) {
      toast({
        title: "Attach failed",
        description: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      const { [skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  async function detach(skillId: string) {
    if (!workspaceId || !jobName) return;
    pending = { ...pending, [skillId]: true };
    try {
      await unassignMut.mutateAsync({ skillId, workspaceId, jobName });
      toast({ title: "Detached from job" });
    } catch (e) {
      toast({
        title: "Detach failed",
        description: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      const { [skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  const workspaceInherited = $derived(jobSkillsQuery.data?.workspaceInherited ?? []);
  const jobSpecific = $derived(jobSkillsQuery.data?.jobSpecific ?? []);
  const friday = $derived(jobSkillsQuery.data?.friday ?? []);
  const available = $derived(jobSkillsQuery.data?.available ?? []);
</script>

<div class="page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  <header class="page-header">
    <div class="title-row">
      <h1>{jobTitle}</h1>
      {#if jobName && jobName !== jobTitle}
        <code class="job-slug">{jobName}</code>
      {/if}
    </div>
    {#if jobDescription}
      <p class="page-subtitle">{jobDescription}</p>
    {/if}
  </header>

  {#if yamlDeclared.length > 0}
    <aside class="yaml-declared">
      <strong>Declared in workspace.yml:</strong>
      {#each yamlDeclared as ref (ref)}<code class="ref-chip">{ref}</code>{/each}
      <p class="hint">
        Declarative only — no assignments are auto-created. Use the Job-specific section below
        to make them take effect.
      </p>
    </aside>
  {/if}

  {#if jobSkillsQuery.isLoading}
    <div class="empty-state"><p>Loading skills…</p></div>
  {:else if jobSkillsQuery.isError}
    <div class="empty-state">
      <p>Failed to load skills</p>
      <span class="hint">{jobSkillsQuery.error?.message}</span>
    </div>
  {:else}
    <!-- Job-specific (editable) -->
    <section class="section">
      <header>
        <h2>Job-specific</h2>
        <span class="count">{jobSpecific.length}</span>
      </header>
      <p class="section-intro">
        Skills pinned to this job only. Not visible to other jobs in the workspace.
      </p>
      {#if jobSpecific.length === 0}
        <p class="empty-hint">No job-specific skills yet. Attach one from "Available" below.</p>
      {:else}
        <div class="skill-list">
          {#each jobSpecific as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot job"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              {#if workspaceInheritedIds.has(skill.skillId)}
                <span class="row-tag warn" title="Dual assignment — workspace layer already covers this">
                  also workspace-level
                </span>
              {/if}
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

    <!-- Workspace-inherited (read-only) -->
    <section class="section">
      <header>
        <h2>Workspace-inherited</h2>
        <span class="count">{workspaceInherited.length}</span>
      </header>
      <p class="section-intro">
        Workspace-level + global skills. Edit on the
        <a href="/platform/{workspaceId}/skills">Workspace Skills</a> page.
      </p>
      {#if workspaceInherited.length === 0}
        <p class="empty-hint">No workspace-wide skills configured.</p>
      {:else}
        <div class="skill-list read-only">
          {#each workspaceInherited as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot ws"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              {#if skill.description}
                <p class="row-description">{skill.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- @friday/* always-available -->
    <section class="section">
      <header>
        <h2>Always available</h2>
        <span class="count">{friday.length}</span>
      </header>
      <p class="section-intro">
        <code>@friday/*</code> skills bypass scoping so every agent can author new skills, create
        workspaces, etc.
      </p>
      {#if friday.length === 0}
        <p class="empty-hint">No @friday/* skills installed.</p>
      {:else}
        <div class="skill-list read-only">
          {#each friday as skill (skill.skillId)}
            <div class="skill-row">
              <a class="row-main" href="/skills/{skill.namespace}/{skill.name}">
                <span class="skill-dot friday"></span>
                <span class="skill-name">{skill.namespace}/{skill.name}</span>
              </a>
              {#if skill.description}
                <p class="row-description">{skill.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Available to attach -->
    <section class="section">
      <header>
        <h2>Available to attach</h2>
        <span class="count">{available.length}</span>
      </header>
      <p class="section-intro">Catalog skills not yet visible to this job.</p>
      {#if available.length === 0}
        <p class="empty-hint">All catalog skills are already visible to this job.</p>
      {:else}
        <div class="skill-list">
          {#each available as skill (skill.skillId)}
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
                Attach to job
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
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .page-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .title-row {
    align-items: baseline;
    display: flex;
    gap: var(--size-3);
  }

  h1 {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
  }

  .job-slug {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .page-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    line-height: 1.5;
    max-inline-size: 60ch;
  }

  .yaml-declared {
    background: color-mix(in srgb, var(--color-surface-2), transparent 40%);
    border: 1px dashed var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--size-2);
    padding: var(--size-3) var(--size-4);
  }

  .yaml-declared strong {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .yaml-declared .hint {
    flex-basis: 100%;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .ref-chip {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: 2px var(--size-2);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .section h2 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .count {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    padding: 0 var(--size-2);
  }

  .section-intro {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 72ch;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-12) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .empty-hint,
  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
  }

  .skill-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--size-2);
  }

  .skill-list.read-only {
    opacity: 0.75;
  }

  .skill-row {
    align-items: center;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: var(--size-1) var(--size-2);
    padding: var(--size-2) var(--size-3);
    position: relative;
  }

  .row-main {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-2);
    text-decoration: none;
  }

  .row-main:hover .skill-name {
    text-decoration: underline;
  }

  .skill-dot {
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .skill-dot.job {
    background-color: var(--color-accent);
  }
  .skill-dot.ws {
    background-color: var(--color-success);
  }
  .skill-dot.friday {
    background-color: var(--color-warning);
  }
  .skill-dot.other {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .skill-name {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .row-tag {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-0);
    font-style: italic;
  }

  .row-tag.warn {
    color: var(--color-warning);
  }

  .row-action {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: 2px var(--size-2);
  }

  .row-action:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .row-action.attach:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent), transparent 85%);
  }

  .row-action.detach:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error), transparent 85%);
  }

  .row-description {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    grid-column: 1 / -1;
    line-height: 1.4;
    margin: 0;
  }
</style>
