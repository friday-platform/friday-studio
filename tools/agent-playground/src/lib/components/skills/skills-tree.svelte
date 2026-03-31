<!--
  Collapsible tree of catalog skills with file children.

  Lists all skills from the catalog grouped by namespace. Clicking a skill
  expands it to reveal Details (SKILL.md) and References sub-items.
  Active file and expansion state are driven by URL route params.

  @component
  @prop dirtyFiles - Set of file paths with unsaved changes (shows dot indicator)
-->

<script lang="ts">
  import { Collapsible, IconSmall, StatusBadge, Tree } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { skillQueries } from "$lib/queries";
  import { writable } from "svelte/store";

  interface Props {
    dirtyFiles?: Set<string>;
  }

  const { dirtyFiles = new Set() }: Props = $props();

  const catalogQuery = createQuery(() => skillQueries.catalog());
  const skills = $derived(catalogQuery.data ?? []);

  // Active skill derived from route params
  const activeNamespace = $derived(page.params.namespace ?? "");
  const activeName = $derived(page.params.name ?? "");
  const activePath = $derived(page.params.path ?? "");
  const hasActiveSkill = $derived(activeNamespace.length > 0 && activeName.length > 0);

  // Group skills by namespace for separator headers
  interface NamespaceGroup {
    namespace: string;
    skills: typeof skills;
  }

  const grouped = $derived.by((): NamespaceGroup[] => {
    const map = new Map<string, typeof skills>();
    for (const skill of skills) {
      const ns = skill.namespace;
      const existing = map.get(ns);
      if (existing) {
        existing.push(skill);
      } else {
        map.set(ns, [skill]);
      }
    }
    return [...map.entries()].map(([namespace, nsSkills]) => ({ namespace, skills: nsSkills }));
  });

  // Fetch files for the expanded skill
  const filesQuery = createQuery(() => ({
    ...skillQueries.files(activeNamespace, activeName),
    enabled: hasActiveSkill,
  }));
  const files = $derived(filesQuery.data?.files ?? []);

  // Reference files (everything except SKILL.md)
  const referenceFiles = $derived(
    files.filter((f: string) => f !== "SKILL.md" && !f.endsWith("/")).sort(),
  );

  // Sync tree expanded state with URL
  const expanded = writable<string[]>([]);

  $effect(() => {
    const ids: string[] = [];
    if (hasActiveSkill) {
      ids.push(`skill:${activeNamespace}/${activeName}`);
    }
    expanded.set(ids);
  });

  function skillId(ns: string, name: string): string {
    return `skill:${ns}/${name}`;
  }

  function handleSkillClick(ns: string, name: string) {
    if (activeNamespace === ns && activeName === name) {
      return;
    }
    goto(`/skills/${ns}/${name}`);
  }

  // Track refs expansion separately — the URL-driven $effect clobbers
  // Melt's internal expanded state, so we manage refs toggle manually.
  let refsExpanded = $state(false);

  function handleDetailsClick(ns: string, name: string) {
    goto(`/skills/${ns}/${name}`);
  }

  function handleFileClick(ns: string, name: string, path: string) {
    goto(`/skills/${ns}/${name}/${path}`);
  }

  function fileName(path: string): string {
    const slashIdx = path.lastIndexOf("/");
    return slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
  }
</script>

<div class="skills-tree">
  {#if catalogQuery.isLoading}
    <p class="tree-status">Loading skills...</p>
  {:else if catalogQuery.isError}
    <p class="tree-status">Failed to load skills</p>
  {:else if skills.length === 0}
    <p class="tree-status">No skills published</p>
  {:else}
    <Tree.Root forceVisible {expanded}>
      {#each grouped as group (group.namespace)}
        <Collapsible.Root defaultOpen={true}>
          <Collapsible.Trigger>
            {#snippet children(_open)}
              <span class="namespace-header">
                @{group.namespace} <IconSmall.CaretDown />
              </span>
            {/snippet}
          </Collapsible.Trigger>
          <Collapsible.Content>

        {#each group.skills as skill (skill.skillId)}
          {@const ns = skill.namespace}
          {@const name = skill.name ?? ""}
          {@const isExpanded = activeNamespace === ns && activeName === name}

          <Tree.Item id={skillId(ns, name)} hasChildren>
            <button
              class="skill-trigger"
              class:expanded={isExpanded}
              onclick={() => handleSkillClick(ns, name)}
            >
              <span class="skill-label">{name}</span>
              {#if skill.disabled}
                <StatusBadge status="skipped" label="Disabled" />
              {/if}
            </button>

            {#if isExpanded}
              <Tree.Group id={skillId(ns, name)}>
                <div class="children-container">
                  <!-- Details (SKILL.md) -->
                  <Tree.Item id={`details:${ns}/${name}`}>
                    <button
                      class="child-entry"
                      class:child-active={hasActiveSkill && activePath === ""}
                      onclick={() => handleDetailsClick(ns, name)}
                    >
                      <span class="child-label">SKILL.md</span>
                      {#if dirtyFiles.has("SKILL.md")}
                        <span class="dirty-dot"></span>
                      {/if}
                    </button>
                  </Tree.Item>

                  <!-- References folder -->
                  {#if filesQuery.isLoading}
                    <span class="tree-status tree-status-inline">Loading files...</span>
                  {:else if referenceFiles.length > 0}
                    <Tree.Item id={`refs:${ns}/${name}`}>
                      <button
                        class="child-entry"
                        onclick={() => { refsExpanded = !refsExpanded; }}
                      >
                        <span class="child-icon"><IconSmall.Folder /></span>
                        <span class="child-label">References</span>
                      </button>

                      {#if refsExpanded}
                        <div class="children-container">
                          {#each referenceFiles as path (path)}
                            <Tree.Item id={`file:${ns}/${name}/${path}`}>
                              <button
                                class="child-entry"
                                class:child-active={activePath === path}
                                onclick={() => handleFileClick(ns, name, path)}
                              >
                                <span class="child-label">{fileName(path)}</span>
                                {#if dirtyFiles.has(path)}
                                  <span class="dirty-dot"></span>
                                {/if}
                              </button>
                            </Tree.Item>
                          {/each}
                        </div>
                      {/if}
                    </Tree.Item>
                  {/if}
                </div>
              </Tree.Group>
            {/if}
          </Tree.Item>
        {/each}

          </Collapsible.Content>
        </Collapsible.Root>
      {/each}
    </Tree.Root>
  {/if}
</div>

<style>
  .skills-tree {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  /* Reset list markers from Tree's <ul>/<li> elements */
  .skills-tree :global(ul),
  .skills-tree :global(li) {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree-status {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-2);
  }

  .tree-status-inline {
    padding-inline-start: var(--size-5);
  }

  /* --- Namespace header ------------------------------------------------------ */

  .namespace-header {
    block-size: var(--size-4);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    margin-block-end: var(--size-1);
    opacity: 0.6;
    padding-inline: var(--size-2);

    :global(svg) {
      transform: rotate(-90deg);
      transition: transform 150ms ease;
    }
  }

  :global([data-melt-collapsible-trigger][data-state="open"]) .namespace-header :global(svg) {
    transform: rotate(0deg);
  }

  /* --- Skill trigger --------------------------------------------------------- */

  .skill-trigger {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: 100%;
    opacity: 0.8;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition: background-color 100ms ease;
  }

  .skill-trigger:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
    opacity: 1;
  }

  .skill-trigger.expanded {
    opacity: 1;
  }

  .skill-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }



  /* --- Children container with tree lines ------------------------------------ */

  .children-container {
    display: flex;
    flex-direction: column;
    margin-inline-start: var(--size-3-5);
  }

  /* Each <li> owns its connector — ::before draws the rounded L-branch,
     ::after draws the vertical continuation to the next sibling. */
  .children-container > :global(li) {
    padding-inline-start: var(--size-2-5);
    position: relative;
  }

  /* Rounded L-branch — vertical down to branch point, curves into horizontal */
  .children-container > :global(li)::before {
    block-size: 14px;
    border-block-end: 1px solid var(--color-border-1);
    border-end-start-radius: 6px;
    border-inline-start: 1px solid var(--color-border-1);
    content: "";
    inline-size: var(--size-2-5);
    inset-block-start: 0;
    inset-inline-start: 0;
    position: absolute;
  }

  /* Vertical continuation — 1px background bar that overlaps the curve zone
     to keep the trunk continuous while the branch curves off. */
  .children-container > :global(li)::after {
    background-color: var(--color-border-1);
    block-size: calc(100% - 8px);
    content: "";
    inline-size: 1px;
    inset-block-start: 8px;
    inset-inline-start: 0;
    position: absolute;
  }

  /* Last item: no vertical continuation */
  .children-container > :global(li:last-child)::after {
    display: none;
  }

  /* --- Child entries (Details, References, files) ---------------------------- */

  .child-entry {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1-5);
    inline-size: 100%;
    opacity: 0.6;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition: background-color 100ms ease;
  }

  .child-entry:not(.child-active):hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
    opacity: 0.9;
  }

  .child-active {
    background-color: var(--color-surface-2);
    opacity: 0.9;
  }

  .child-icon {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-shrink: 0;
  }

  .child-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }


  /* --- Dirty indicator ------------------------------------------------------- */

  .dirty-dot {
    background-color: var(--color-warning);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }
</style>
