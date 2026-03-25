<!--
  Collapsible tree of catalog skills with file children.

  Lists all skills from the catalog. Clicking a skill expands it to reveal
  SKILL.md and reference files grouped by directory. Active file and expansion
  state are driven by URL route params.

  @component
  @prop dirtyFiles - Set of file paths with unsaved changes (shows dot indicator)
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { skillQueries } from "$lib/queries";

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

  // Fetch files for the expanded skill
  const filesQuery = createQuery(() => ({
    ...skillQueries.files(activeNamespace, activeName),
    enabled: activeNamespace.length > 0 && activeName.length > 0,
  }));
  const files = $derived(filesQuery.data?.files ?? []);

  // Group files by top-level directory
  interface DirGroup {
    dir: string;
    files: string[];
  }

  const fileTree = $derived.by((): DirGroup[] => {
    if (files.length === 0) return [];

    const groups = new Map<string, string[]>();
    for (const path of files) {
      if (path === "SKILL.md") continue;
      const slashIdx = path.indexOf("/");
      const dir = slashIdx >= 0 ? path.slice(0, slashIdx) : "";
      const existing = groups.get(dir);
      if (existing) {
        existing.push(path);
      } else {
        groups.set(dir, [path]);
      }
    }

    return [...groups.entries()].map(([dir, dirFiles]) => ({ dir, files: dirFiles.sort() }));
  });

  // Collapsed directories within the file tree
  let collapsedDirs: Set<string> = $state(new Set());

  function toggleDir(dir: string) {
    const next = new Set(collapsedDirs);
    if (next.has(dir)) {
      next.delete(dir);
    } else {
      next.add(dir);
    }
    collapsedDirs = next;
  }

  function isExpanded(ns: string, name: string): boolean {
    return activeNamespace === ns && activeName === name;
  }

  function isActiveFile(path: string): boolean {
    return activePath === path;
  }

  function isSkillMdActive(): boolean {
    return hasActiveSkill && activePath === "";
  }

  function fileName(path: string): string {
    const slashIdx = path.lastIndexOf("/");
    return slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
  }

  function handleSkillClick(ns: string, name: string) {
    if (isExpanded(ns, name)) {
      // Collapse: navigate back to skill list
      goto("/skills");
    } else {
      // Expand: navigate to skill detail (selects SKILL.md)
      goto(`/skills/${ns}/${name}`);
    }
  }

  function handleFileClick(ns: string, name: string, path: string) {
    goto(`/skills/${ns}/${name}/${path}`);
  }

  function handleSkillMdClick(ns: string, name: string) {
    goto(`/skills/${ns}/${name}`);
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
    {#each skills as skill (skill.skillId)}
      {@const ns = skill.namespace}
      {@const name = skill.name ?? ""}
      {@const expanded = isExpanded(ns, name)}
      <div class="skill-node">
        <button class="skill-trigger" class:expanded onclick={() => handleSkillClick(ns, name)}>
          <span class="caret" class:caret-expanded={expanded}>&#9662;</span>
          <span class="skill-label">@{ns}/{name}</span>
          {#if skill.disabled}
            <span class="disabled-tag">OFF</span>
          {/if}
        </button>

        {#if expanded}
          <div class="skill-children">
            <!-- SKILL.md entry -->
            <button
              class="file-entry"
              class:file-active={isSkillMdActive()}
              onclick={() => handleSkillMdClick(ns, name)}
            >
              <span class="file-name">SKILL.md</span>
              {#if dirtyFiles.has("SKILL.md")}
                <span class="dirty-dot"></span>
              {/if}
            </button>

            <!-- Reference files grouped by directory -->
            {#if filesQuery.isLoading}
              <span class="tree-status tree-status-inline">Loading files...</span>
            {:else}
              {#each fileTree as group}
                {#if group.dir}
                  <button class="dir-trigger" onclick={() => toggleDir(group.dir)}>
                    <span class="caret" class:caret-expanded={!collapsedDirs.has(group.dir)}>
                      &#9662;
                    </span>
                    {group.dir}
                  </button>
                {/if}
                {#if !group.dir || !collapsedDirs.has(group.dir)}
                  {#each group.files as path}
                    <button
                      class="file-entry"
                      class:file-nested={!!group.dir}
                      class:file-active={isActiveFile(path)}
                      onclick={() => handleFileClick(ns, name, path)}
                    >
                      <span class="file-name">{fileName(path)}</span>
                      {#if dirtyFiles.has(path)}
                        <span class="dirty-dot"></span>
                      {/if}
                    </button>
                  {/each}
                {/if}
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .skills-tree {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .tree-status {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-2);
  }

  .tree-status-inline {
    padding-inline-start: var(--size-5);
  }

  /* --- Skill node ---------------------------------------------------------- */

  .skill-node {
    display: flex;
    flex-direction: column;
  }

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

  .disabled-tag {
    color: var(--color-error);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  /* --- Caret -------------------------------------------------------------- */

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

  /* --- Children (files) ---------------------------------------------------- */

  .skill-children {
    display: flex;
    flex-direction: column;
    padding-inline-start: var(--size-3);
  }

  .dir-trigger {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    opacity: 0.6;
    padding: var(--size-1) var(--size-2);
    text-align: start;
  }

  .dir-trigger:hover {
    opacity: 0.9;
  }

  .file-entry {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    opacity: 0.6;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition: background-color 100ms ease;
  }

  .file-entry:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
    opacity: 0.9;
  }

  .file-nested {
    padding-inline-start: var(--size-5);
  }

  .file-active {
    background-color: var(--color-surface-2);
    font-weight: var(--font-weight-5);
    opacity: 0.9;
  }

  .file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- Dirty indicator ----------------------------------------------------- */

  .dirty-dot {
    background-color: var(--color-warning);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }
</style>
