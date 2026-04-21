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
  import { Dialog, toast } from "@atlas/ui";
  import { createQuery, queryOptions, skipToken } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import SkillsShImport from "$lib/components/skills/skills-sh-import.svelte";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries } from "$lib/queries";
  import {
    searchSkillsSh,
    useAssignSkill,
    useInstallSkill,
    useUnassignSkill,
  } from "$lib/queries/skills";
  import { writable } from "svelte/store";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const classifiedQuery = createQuery(() =>
    skillQueries.classifiedWorkspaceSkills(workspaceId),
  );

  const assignMut = useAssignSkill();
  const unassignMut = useUnassignSkill();
  const installMut = useInstallSkill();

  let installSource = $state("");
  let searchFocused = $state(false);

  // --- Add Skill dialog (Upload + Import tabs, same UX as the global /skills page)
  // Triggered by `?addSkill=true` from the workspace sidebar button, so the
  // user gets the full picker instead of just being dumped at the inline
  // search input. Imports via this dialog auto-assign to the workspace.
  const addDialogOpen = writable(false);
  let addMode = $state<"upload" | "import">("upload");

  $effect(() => {
    if (!browser) return;
    if (page.url.searchParams.get("addSkill") !== "true") return;
    addMode = "upload";
    addDialogOpen.set(true);
    const url = new URL(page.url.href);
    url.searchParams.delete("addSkill");
    goto(url.pathname + url.search, { replaceState: true, noScroll: true });
  });
  /** Debounced copy of `installSource` — the TanStack query key. Without the
   *  debounce every keystroke fires a fetch. */
  let searchQuery = $state("");
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  function handleSourceInput(e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    installSource = v;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = v.trim();
    }, 200);
  }

  /**
   * Autocomplete query over skills.sh. Only fires when the user is actively
   * typing something short enough to be a search term (not already a full
   * `owner/repo/slug`) — once they paste a 3-segment ref, skip search.
   */
  const searchSuggestions = createQuery(() =>
    queryOptions({
      queryKey: ["skillssh-search", searchQuery] as const,
      queryFn:
        searchQuery.length >= 2 && searchQuery.split("/").filter(Boolean).length < 3
          ? () => searchSkillsSh(searchQuery, 8)
          : skipToken,
      staleTime: 60_000,
    }),
  );
  const suggestions = $derived(searchSuggestions.data?.skills ?? []);
  const showSuggestions = $derived(
    searchFocused && installSource.trim().length >= 2 && suggestions.length > 0,
  );

  function pickSuggestion(id: string): void {
    installSource = id;
    searchQuery = id; // clears the suggestions (3-segment ref disables the query)
    searchFocused = false;
  }

  async function doInstall(): Promise<void> {
    const source = installSource.trim();
    if (!source || !workspaceId) return;
    try {
      const res = await installMut.mutateAsync({
        source,
        workspaceId,
      });
      const published = res.published as
        | { namespace: string; name: string; version: number }
        | undefined;
      const ref = published ? `@${published.namespace}/${published.name}` : source;
      toast({
        title: "Skill installed",
        description: `${ref} — assigned to this workspace.`,
      });
      installSource = "";
    } catch (e) {
      const err = e as Error & { data?: Record<string, unknown> };
      const data = err.data;
      const auditCritical =
        data && Array.isArray(data.auditCritical) ? data.auditCritical.length : 0;
      const lintErrors = data && Array.isArray(data.lintErrors) ? data.lintErrors.length : 0;
      const detail = auditCritical > 0 ? ` · ${String(auditCritical)} critical audit` : "";
      const lintDetail = lintErrors > 0 ? ` · ${String(lintErrors)} lint errors` : "";
      toast({
        title: "Install failed",
        description: `${err.message ?? "Unknown error"}${detail}${lintDetail}`,
        error: true,
      });
    }
  }

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

    <!-- Inline install form. Accepts owner/repo/slug (as returned by skills.sh
         /search). Server runs local audit + publish-time lint, auto-assigns
         official sources to this workspace, requires the acknowledge box for
         community sources with warnings. -->
    <section class="install-section">
      <div class="install-row">
        <div class="source-wrapper">
          <input
            class="source-input"
            type="text"
            value={installSource}
            oninput={handleSourceInput}
            onfocus={() => (searchFocused = true)}
            onblur={() => setTimeout(() => (searchFocused = false), 150)}
            placeholder="Install from skills.sh — type to search (e.g. pdf, react, sql)"
            autocomplete="off"
          />
          {#if searchFocused && installSource.trim().length >= 2 && searchSuggestions.isFetching}
            <div class="search-status">Searching skills.sh…</div>
          {/if}
          {#if showSuggestions}
            <ul class="suggestions">
              {#each suggestions as s (s.id)}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <li
                  class="suggestion"
                  onmousedown={(e) => {
                    e.preventDefault();
                    pickSuggestion(s.id);
                  }}
                >
                  <span class="sugg-name">{s.name}</span>
                  <span class="sugg-src">{s.source}</span>
                  <span class="sugg-meta">
                    <span class="tier-tag tier-{s.tier}">{s.tier}</span>
                    <span class="installs">{s.installs.toLocaleString()} installs</span>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <button
          type="button"
          class="install-btn"
          disabled={installMut.isPending || installSource.trim().length === 0}
          onclick={doInstall}
        >
          {installMut.isPending ? "Installing…" : "Install"}
        </button>
      </div>
    </section>
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

<Dialog.Root open={addDialogOpen}>
  {#snippet children()}
    <Dialog.Content size="auto">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Add skill</Dialog.Title>
        <Dialog.Description>
          Upload a folder you authored, or import one from skills.sh. Either way it lands
          in this workspace.
        </Dialog.Description>
      {/snippet}

      <div class="add-tabs" role="tablist">
        <button
          type="button"
          class="tab"
          class:active={addMode === "upload"}
          role="tab"
          aria-selected={addMode === "upload"}
          onclick={() => {
            addMode = "upload";
          }}
        >
          Upload file / folder
        </button>
        <button
          type="button"
          class="tab"
          class:active={addMode === "import"}
          role="tab"
          aria-selected={addMode === "import"}
          onclick={() => {
            addMode = "import";
          }}
        >
          Import from skills.sh
        </button>
      </div>

      {#if addMode === "upload"}
        <SkillLoader inline onclose={() => addDialogOpen.set(false)} />
      {:else if workspaceId}
        <SkillsShImport
          {workspaceId}
          onclose={() => addDialogOpen.set(false)}
        />
      {/if}

      {#snippet footer()}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .skills-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .install-section {
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-4);
  }

  .install-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .source-wrapper {
    flex-grow: 1;
    min-inline-size: 280px;
    position: relative;
  }

  .source-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-1);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
  }

  .search-status {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    padding: var(--size-1) var(--size-3);
  }

  .suggestions {
    background: var(--color-surface-1, var(--color-surface-2));
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    inset-block-start: calc(100% + 4px);
    inset-inline: 0;
    margin: 0;
    max-block-size: 280px;
    overflow-y: auto;
    padding: var(--size-1);
    position: absolute;
    z-index: 20;
  }

  .suggestion {
    align-items: baseline;
    cursor: pointer;
    display: grid;
    gap: var(--size-1) var(--size-2);
    grid-template-columns: auto 1fr auto;
    padding: var(--size-2);
    border-radius: var(--radius-1);
  }

  .suggestion:hover {
    background-color: color-mix(in srgb, var(--color-primary, #6272ff), transparent 85%);
  }

  .sugg-name {
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
  }

  .sugg-src {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sugg-meta {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .tier-tag {
    border-radius: var(--radius-1);
    font-size: 9px;
    font-weight: var(--font-weight-7);
    letter-spacing: 0.04em;
    padding: 1px 5px;
    text-transform: uppercase;
  }

  /* OFFICIAL — green, signals a trusted/curated source. */
  .tier-official {
    background-color: color-mix(in oklch, var(--color-success, #238636), transparent 80%);
    color: color-mix(in oklch, var(--color-success, #238636), var(--color-text) 40%);
  }

  /* COMMUNITY — blue, signals user-contributed. Distinct from official. */
  .tier-community {
    background-color: color-mix(in oklch, var(--color-accent-blue, #1f6feb), transparent 80%);
    color: color-mix(in oklch, var(--color-accent-blue, #1f6feb), var(--color-text) 40%);
  }

  .installs {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-0);
  }


  .install-btn {
    background: var(--color-primary, #6272ff);
    border: none;
    border-radius: var(--radius-2);
    color: #fff;
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-2) var(--size-4);
  }

  .install-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .install-message {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-1);
    margin: 0;
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

  /* --- Add Skill dialog tabs (same visual as /skills layout) --- */

  .add-tabs {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    inline-size: min(720px, 92vw);
    justify-content: center;
    margin-block-end: var(--size-4);
    padding-block-end: var(--size-2);
  }

  .tab {
    background: transparent;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin-block-end: -2px;
    padding-block: var(--size-1);
    padding-inline: var(--size-3);
    transition: color 120ms ease, border-color 120ms ease;
  }

  .tab:hover { color: var(--color-text); }

  .tab.active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }
</style>
