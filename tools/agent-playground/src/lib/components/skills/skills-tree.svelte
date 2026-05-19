<!--
  Collapsible tree of catalog skills with file children.

  Lists all skills from the catalog grouped by namespace. Clicking a skill
  expands it in place to reveal Details (SKILL.md) and References sub-items.
  Active file and expansion state are driven by URL route params.

  @component
  @prop dirtyFiles - Set of file paths with unsaved changes (shows dot indicator)
-->

<script lang="ts">
  import { IconSmall, SidebarNav, StatusBadge } from "@atlas/ui";
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

  function handleSkillClick(ns: string, name: string) {
    if (activeNamespace === ns && activeName === name) return;
    goto(`/skills/${ns}/${name}`);
  }

  // Track refs expansion separately — it's local UI state, not URL-driven.
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

  /**
   * Short provenance label from the `source` frontmatter field. Origin host
   * (e.g. `skills.sh`, `github.com`) — local skills have no source.
   */
  function sourceLabel(source: string | undefined): string | null {
    if (!source) return null;
    if (source.startsWith("skills.sh/")) return "skills.sh";
    if (source.startsWith("github.com/") || source.startsWith("https://github.com/")) {
      return "github";
    }
    const first = source.split("/")[0];
    return first && first.length > 0 ? first : null;
  }
</script>

{#if catalogQuery.isLoading}
  <p class="tree-status text-xs">Loading skills...</p>
{:else if catalogQuery.isError}
  <p class="tree-status text-xs">Failed to load skills</p>
{:else if skills.length === 0}
  <p class="tree-status text-xs">No skills published</p>
{:else}
  <SidebarNav.Root>
    {#each grouped as group (group.namespace)}
      {@const containsActive = group.skills.some(
        (s) => s.namespace === activeNamespace && s.name === activeName,
      )}
      <SidebarNav.Group
        label={group.namespace}
        count={group.skills.length}
        defaultOpen={containsActive}
      >
        {#each group.skills as skill (skill.skillId)}
          {@const ns = skill.namespace}
          {@const name = skill.name ?? ""}
          {@const isExpanded = activeNamespace === ns && activeName === name}
          {@const src = sourceLabel(skill.source)}

          <SidebarNav.Item
            active={isExpanded}
            expanded={isExpanded}
            onclick={() => handleSkillClick(ns, name)}
          >
            <span class="skill-label">{name}</span>
            {#if src}
              <span class="source-badge text-2xs" title={skill.source}>{src}</span>
            {/if}
            {#if skill.disabled}
              <StatusBadge status="skipped" label="Disabled" />
            {/if}

            {#snippet subItems()}
              <!-- SKILL.md -->
              <SidebarNav.Item
                variant="sub"
                active={hasActiveSkill && activePath === ""}
                onclick={() => handleDetailsClick(ns, name)}
              >
                <span class="child-label">SKILL.md</span>
                {#if dirtyFiles.has("SKILL.md")}
                  <span class="dirty-dot"></span>
                {/if}
              </SidebarNav.Item>

              <!-- References folder -->
              {#if filesQuery.isLoading}
                <p class="tree-status tree-status-inline text-xs">Loading files...</p>
              {:else if referenceFiles.length > 0}
                <SidebarNav.Item
                  variant="sub"
                  expanded={refsExpanded}
                  onclick={() => (refsExpanded = !refsExpanded)}
                >
                  <span class="child-icon"><IconSmall.Folder /></span>
                  <span class="child-label">References</span>

                  {#snippet subItems()}
                    {#each referenceFiles as path (path)}
                      <SidebarNav.Item
                        variant="sub"
                        active={activePath === path}
                        onclick={() => handleFileClick(ns, name, path)}
                      >
                        <span class="child-label">{fileName(path)}</span>
                        {#if dirtyFiles.has(path)}
                          <span class="dirty-dot"></span>
                        {/if}
                      </SidebarNav.Item>
                    {/each}
                  {/snippet}
                </SidebarNav.Item>
              {/if}
            {/snippet}
          </SidebarNav.Item>
        {/each}
      </SidebarNav.Group>
    {/each}
  </SidebarNav.Root>
{/if}

<style>
  .tree-status {
    color: var(--text-faded);
    padding: var(--size-2) var(--size-2);
  }

  .tree-status-inline {
    padding-inline-start: var(--size-5);
  }

  .skill-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-badge {
    background-color: var(--highlight);
    border-radius: var(--radius-2);
    color: var(--text-faded);
    flex-shrink: 0;
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
    padding: 1px var(--size-1);
  }

  .child-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .child-icon {
    align-items: center;
    color: var(--text-faded);
    display: flex;
    flex-shrink: 0;
  }

  .dirty-dot {
    background-color: var(--yellow-primary);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }
</style>
