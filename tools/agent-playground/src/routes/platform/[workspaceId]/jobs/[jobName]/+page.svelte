<!--
  Job Skills — two-section layout ("B2 · v3" from the redesign canvas).

  Visible to this job  →  Catalog
  No facet sidebar. Namespace and yaml-declared status render as row pills
  (yaml pill only on Visible rows — it's irrelevant in Catalog).

  Source color language:
    • accent  = pinned to this job (detachable here)
    • success = workspace-inherited (managed on Workspace Skills page)
    • warning = @friday/* always-available
    • neutral = catalog candidate (available to attach)

  Keyboard: `/` focuses the Visible search (outside of inputs).
-->

<script lang="ts">
  import { markdownToHTML, toast } from "@atlas/ui";
  import { createQuery, queryOptions, skipToken } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { skillQueries, workspaceQueries } from "$lib/queries";
  import {
    searchSkillsSh,
    useAssignSkill,
    useDeleteSkill,
    useInstallSkill,
    useUnassignSkill,
  } from "$lib/queries/skills";

  type Source = "job" | "workspace" | "friday";
  interface SkillRow {
    skillId: string;
    id: string;
    namespace: string;
    name: string | null;
    description: string;
    latestVersion: number;
  }

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const jobName = $derived(page.params.jobName ?? null);

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const jobSkillsQuery = createQuery(() => skillQueries.jobSkills(workspaceId, jobName));

  const assignMut = useAssignSkill();
  const unassignMut = useUnassignSkill();
  const installMut = useInstallSkill();
  const deleteSkillMut = useDeleteSkill();

  const jobTitle = $derived.by(() => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return jobName ?? "Job";
    const job = (cfg.jobs as Record<string, { title?: string }> | undefined)?.[jobName];
    return job?.title ?? jobName;
  });

  const jobDescription = $derived.by(() => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return null;
    const job = (cfg.jobs as Record<string, { description?: string }> | undefined)?.[jobName];
    return job?.description ?? null;
  });

  const yamlDeclared = $derived.by((): Set<string> => {
    const cfg = configQuery.data?.config;
    if (!cfg || !jobName) return new Set();
    const job = (cfg.jobs as Record<string, { skills?: string[] }> | undefined)?.[jobName];
    const refs = Array.isArray(job?.skills) ? job.skills : [];
    // Refs in YAML use "@ns/name" form; strip the leading "@" for O(1) match.
    return new Set(refs.map((r) => (r.startsWith("@") ? r.slice(1) : r)));
  });

  /**
   * Flatten the three visible buckets into a single priority-ordered list,
   * deduplicating by skillId so a dual-assigned skill renders once with the
   * most specific source wins (job > workspace > friday).
   */
  const visibleRows = $derived.by((): (SkillRow & { source: Source })[] => {
    const data = jobSkillsQuery.data;
    if (!data) return [];
    const seen = new Set<string>();
    const rows: (SkillRow & { source: Source })[] = [];
    const push = (list: SkillRow[], source: Source) => {
      for (const s of list) {
        if (seen.has(s.skillId)) continue;
        seen.add(s.skillId);
        rows.push({ ...s, source });
      }
    };
    push(data.jobSpecific, "job");
    push(data.workspaceInherited.filter((s) => s.namespace !== "friday"), "workspace");
    push(data.friday, "friday");
    return rows;
  });

  const catalogRows = $derived(jobSkillsQuery.data?.available ?? []);

  // Independent search state per section.
  let qVisible = $state("");
  let qCatalog = $state("");
  let visibleSearchEl = $state<HTMLInputElement | null>(null);

  function matches(q: string, s: SkillRow): boolean {
    if (!q.trim()) return true;
    const hay = `${s.namespace}/${s.name} ${s.description}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  const visibleFiltered = $derived(visibleRows.filter((s) => matches(qVisible, s)));
  const catalogFiltered = $derived(catalogRows.filter((s) => matches(qCatalog, s)));
  const effective = $derived(visibleRows.length);

  // Skill detail drawer (click a row to peek).
  let selected = $state<(SkillRow & { source: Source | null }) | null>(null);

  // Optimistic dim while attach/detach round-trips.
  let pending = $state<Record<string, boolean>>({});

  // ─── skills.sh install experience (mirrors /platform/:ws/skills) ───────
  // Same UX as the Workspace Skills page: input with a typeahead dropdown
  // of skills.sh matches; selecting a suggestion fills the input;
  // pressing "Install" pulls the skill into the catalog. Only difference:
  // on this page we follow up with a job-level assignment instead of
  // workspace-level, so the installed skill lands pinned to THIS job.

  let installSource = $state("");
  let searchFocused = $state(false);
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

  const searchSuggestions = createQuery(() =>
    queryOptions({
      queryKey: ["skillssh-search-job", searchQuery] as const,
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
    searchQuery = id;
    searchFocused = false;
  }

  async function doInstall(): Promise<void> {
    const source = installSource.trim();
    if (!source || !workspaceId || !jobName) return;
    try {
      // Install WITHOUT workspaceId — we don't want a workspace-level
      // assignment; we want the skill pinned to THIS job only.
      const res = (await installMut.mutateAsync({ source })) as {
        published?: { skillId: string; namespace: string; name: string; version: number };
      };
      const published = res.published;
      const ref = published ? `@${published.namespace}/${published.name}` : source;
      if (!published?.skillId) {
        toast({
          title: "Installed",
          description: `${ref} — in catalog, but couldn't auto-pin. Attach from Catalog below.`,
        });
        installSource = "";
        return;
      }
      await assignMut.mutateAsync({ skillId: published.skillId, workspaceId, jobName });
      toast({
        title: "Installed + pinned",
        description: `${ref} → ${jobName}`,
      });
      installSource = "";
      searchQuery = "";
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

  $effect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && selected) {
        selected = null;
        return;
      }
      if (e.key !== "/") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      visibleSearchEl?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function attach(skill: SkillRow) {
    if (!workspaceId || !jobName) return;
    pending = { ...pending, [skill.skillId]: true };
    try {
      await assignMut.mutateAsync({ skillId: skill.skillId, workspaceId, jobName });
      toast({ title: "Attached", description: `${skill.namespace}/${skill.name} → ${jobName}` });
    } catch (e) {
      toast({
        title: "Attach failed",
        description: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      const { [skill.skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  async function detach(skill: SkillRow) {
    if (!workspaceId || !jobName) return;
    pending = { ...pending, [skill.skillId]: true };
    try {
      await unassignMut.mutateAsync({ skillId: skill.skillId, workspaceId, jobName });

      // The additive-visibility model treats zero-assignment skills as
      // globally visible — which would make a just-detached skill
      // reappear in the "workspace-inherited" bucket immediately. The
      // user's mental model on this page is "Detach = I'm done with
      // this skill here", so if removing the job row leaves the skill
      // with no assignments anywhere, uninstall it from the catalog.
      // Skills still pinned to other workspaces or jobs are left alone.
      const res = await fetch(
        `/api/daemon/api/skills/scoping/${encodeURIComponent(skill.skillId)}/assignments`,
      );
      if (res.ok) {
        const body = (await res.json()) as { workspaceIds: string[] };
        if (body.workspaceIds.length === 0) {
          await deleteSkillMut.mutateAsync(skill.skillId);
          toast({
            title: "Detached + uninstalled",
            description: `${skill.namespace}/${skill.name} — nothing else used it.`,
          });
          return;
        }
      }

      toast({ title: "Detached", description: `${skill.namespace}/${skill.name}` });
    } catch (e) {
      toast({
        title: "Detach failed",
        description: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      const { [skill.skillId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  function displayCount(filtered: number, total: number): string {
    return filtered === total ? String(total) : `${filtered} / ${total}`;
  }

  function sourceLabel(src: Source): string {
    if (src === "job") return "pinned";
    if (src === "workspace") return "workspace";
    return "always";
  }
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
      <span class="effective-count" title="Total skills visible to this job">
        {effective} visible
      </span>
    </div>
    {#if jobDescription}
      <p class="page-subtitle">{jobDescription}</p>
    {/if}
  </header>

  <!-- Install-from-skills.sh — mirrors /platform/:ws/skills. The only
       behavioural difference: installing here auto-pins the new skill to
       THIS job (workspaceId + jobName) instead of making it visible to
       the whole workspace. -->
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
        {installMut.isPending ? "Installing…" : "Install + pin"}
      </button>
    </div>
  </section>

  {#if jobSkillsQuery.isLoading}
    <div class="empty"><p>Loading skills…</p></div>
  {:else if jobSkillsQuery.isError}
    <div class="empty">
      <p>Failed to load skills</p>
      <span class="hint">{jobSkillsQuery.error?.message}</span>
    </div>
  {:else}
    <section class="skills-section">
      <div class="section-head">
        <h2>Visible to this job</h2>
        <span class="count-chip">{displayCount(visibleFiltered.length, effective)}</span>
        <div class="grow"></div>
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M11 11l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            bind:value={qVisible}
            bind:this={visibleSearchEl}
            placeholder="Search visible… (press /)"
            type="text"
            aria-label="Search skills visible to this job"
          />
        </div>
      </div>

      {#if visibleRows.length === 0}
        <div class="empty inline">
          <p>No skills visible yet</p>
          <span class="hint">Attach one from the catalog below.</span>
        </div>
      {:else if visibleFiltered.length === 0}
        <div class="empty inline"><p>No matches</p></div>
      {:else}
        {#each visibleFiltered as skill (skill.skillId)}
          {@const isYaml = skill.name !== null && yamlDeclared.has(`${skill.namespace}/${skill.name}`)}
          <div
            class="row"
            class:dim={pending[skill.skillId]}
            onclick={() => (selected = { ...skill, source: skill.source })}
            onkeydown={(e) => (e.key === "Enter" ? (selected = { ...skill, source: skill.source }) : null)}
            role="button"
            tabindex="0"
          >
            <span class="src-dot src-{skill.source}"></span>
            <div class="row-body">
              <span class="skill-name">{skill.namespace}/{skill.name}</span>
              <span class="pill pill-neutral">{skill.namespace}</span>
              <span class="pill pill-{skill.source}">{sourceLabel(skill.source)}</span>
              {#if isYaml}
                <span class="pill pill-yaml" title="Declared in workspace.yml for this job">yaml</span>
              {/if}
              <span class="desc">{skill.description}</span>
              <span class="version">v{skill.latestVersion}</span>
            </div>
            {#if skill.source === "job"}
              <button
                type="button"
                class="row-action detach"
                disabled={pending[skill.skillId]}
                onclick={(e) => {
                  e.stopPropagation();
                  detach(skill);
                }}
              >
                Detach
              </button>
            {:else}
              <span
                class="row-locked"
                title={skill.source === "workspace"
                  ? "Managed on the Workspace Skills page"
                  : "@friday/* skills are always available"}
                aria-label="Not editable here"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <rect x="3" y="7" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M5 7V5a3 3 0 016 0v2" fill="none" stroke="currentColor" stroke-width="1.5" />
                </svg>
              </span>
            {/if}
          </div>
        {/each}
      {/if}
    </section>

    <section class="skills-section">
      <div class="section-head">
        <h2>Catalog</h2>
        <span class="count-chip">{displayCount(catalogFiltered.length, catalogRows.length)}</span>
        <div class="grow"></div>
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M11 11l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            bind:value={qCatalog}
            placeholder="Search catalog…"
            type="text"
            aria-label="Search catalog skills"
          />
        </div>
      </div>

      {#if catalogRows.length === 0}
        <div class="empty inline">
          <p>All catalog skills already visible</p>
          <span class="hint">Install a new one from skills.sh above.</span>
        </div>
      {:else if catalogFiltered.length === 0}
        <div class="empty inline"><p>No matches</p></div>
      {:else}
        {#each catalogFiltered as skill (skill.skillId)}
          <div
            class="row"
            class:dim={pending[skill.skillId]}
            onclick={() => (selected = { ...skill, source: null })}
            onkeydown={(e) => (e.key === "Enter" ? (selected = { ...skill, source: null }) : null)}
            role="button"
            tabindex="0"
          >
            <span class="src-dot src-available"></span>
            <div class="row-body">
              <span class="skill-name">{skill.namespace}/{skill.name}</span>
              <span class="pill pill-neutral">{skill.namespace}</span>
              <span class="desc">{skill.description}</span>
              <span class="version">v{skill.latestVersion}</span>
            </div>
            <button
              type="button"
              class="row-action attach"
              disabled={pending[skill.skillId]}
              onclick={(e) => {
                e.stopPropagation();
                attach(skill);
              }}
            >
              + Attach
            </button>
          </div>
        {/each}
      {/if}
    </section>
  {/if}
</div>

{#if selected}
  {@const sel = selected}
  <button
    type="button"
    class="drawer-overlay"
    onclick={() => (selected = null)}
    aria-label="Close drawer"
  ></button>
  <aside
    class="drawer"
    role="dialog"
    aria-label="Skill details"
  >
    <header class="drawer-head">
      <div>
        <div class="drawer-kicker">Skill</div>
        <div class="drawer-title">
          <span class="dim">{sel.namespace}/</span><span class="solid">{sel.name}</span>
        </div>
      </div>
      <button type="button" class="drawer-close" onclick={() => (selected = null)} aria-label="Close">
        ✕
      </button>
    </header>
    <!-- Description is authored markdown — render it, don't dump the raw string. -->
    <div class="drawer-desc markdown-body">{@html markdownToHTML(sel.description)}</div>
    <dl class="drawer-meta">
      <dt>Version</dt><dd>v{sel.latestVersion}</dd>
      <dt>Namespace</dt><dd>{sel.namespace}</dd>
      <dt>Source</dt><dd>{sel.source ? sourceLabel(sel.source) : "available"}</dd>
    </dl>
    <footer class="drawer-foot">
      <a href="/skills/{sel.namespace}/{sel.name}" class="drawer-link">Open skill page →</a>
    </footer>
  </aside>
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    padding: var(--size-6) var(--size-8);
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
    font-size: var(--font-size-8);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .job-slug {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
  }

  .effective-count {
    margin-inline-start: auto;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .page-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-4);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 72ch;
  }

  /* ─── Section ──────────────────────────────────────────────────────────── */

  .skills-section {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    overflow: hidden;
    background: var(--color-surface-1);
  }

  .section-head {
    align-items: center;
    background: var(--color-surface-2);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2-5) var(--size-4);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .section-head h2 {
    font-size: var(--font-size-5);
    font-weight: 600;
    margin: 0;
  }

  .count-chip {
    background: var(--color-surface-3);
    border-radius: 999px;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: 0 var(--size-2);
  }

  .grow {
    flex: 1;
  }

  .search-wrap {
    align-items: center;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-1-5);
    padding: var(--size-0-75) var(--size-2);
    inline-size: min(240px, 40vw);
  }

  .search-wrap:focus-within {
    border-color: var(--color-accent);
  }

  .search-wrap input {
    background: transparent;
    border: none;
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-3);
    inline-size: 100%;
    outline: none;
    padding: 0;
  }

  .search-icon {
    block-size: 12px;
    inline-size: 12px;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    flex-shrink: 0;
  }

  /* ─── Install from skills.sh (shared UX w/ /platform/:ws/skills) ─────── */

  .install-section {
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
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
    font-family: var(--font-family-monospace, monospace);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
  }
  .source-input:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  .search-status {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    padding: var(--size-1) var(--size-3);
  }

  .suggestions {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    inset-block-start: calc(100% + 4px);
    inset-inline: 0;
    list-style: none;
    margin: 0;
    max-block-size: 280px;
    overflow-y: auto;
    padding: var(--size-1);
    position: absolute;
    z-index: 20;
  }

  .suggestion {
    align-items: baseline;
    border-radius: var(--radius-1);
    cursor: pointer;
    display: grid;
    gap: var(--size-1) var(--size-2);
    grid-template-columns: auto 1fr auto;
    padding: var(--size-2);
  }
  .suggestion:hover {
    background: color-mix(in srgb, var(--color-accent), transparent 88%);
  }

  .sugg-name {
    font-family: var(--font-family-monospace, monospace);
    font-size: var(--font-size-2);
    font-weight: 600;
  }

  .sugg-src {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace, monospace);
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
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    text-transform: uppercase;
  }
  .tier-official {
    background: color-mix(in oklch, var(--color-success), transparent 80%);
    color: color-mix(in oklch, var(--color-success), var(--color-text) 40%);
  }
  .tier-community {
    background: color-mix(in oklch, var(--color-accent), transparent 80%);
    color: color-mix(in oklch, var(--color-accent), var(--color-text) 40%);
  }

  .installs {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-0);
  }

  .install-btn {
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius-2);
    color: white;
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: 500;
    padding: var(--size-2) var(--size-4);
    transition: opacity 80ms ease;
  }
  .install-btn:hover:not(:disabled) { opacity: 0.88; }
  .install-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  /* ─── Row ──────────────────────────────────────────────────────────────── */

  .row {
    align-items: center;
    background: transparent;
    border: none;
    border-block-end: 1px solid var(--color-border-1);
    color: inherit;
    cursor: pointer;
    display: grid;
    font-family: inherit;
    gap: var(--size-2);
    grid-template-columns: auto 1fr auto;
    inline-size: 100%;
    padding: var(--size-1-5) var(--size-4);
    text-align: start;
    transition: background 80ms ease, opacity 120ms ease;
  }

  .row:last-of-type {
    border-block-end: none;
  }

  .row:hover,
  .row:focus-visible {
    background: color-mix(in srgb, var(--color-text), transparent 96%);
    outline: none;
  }

  .row.dim {
    opacity: 0.45;
    pointer-events: none;
  }

  .src-dot {
    block-size: 6px;
    border-radius: 50%;
    inline-size: 6px;
  }
  .src-dot.src-job { background: var(--color-accent); }
  .src-dot.src-workspace { background: var(--color-success); }
  .src-dot.src-friday { background: var(--color-warning); }
  .src-dot.src-available {
    background: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  .row-body {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .skill-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    white-space: nowrap;
  }

  .desc {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex: 1;
    font-size: var(--font-size-2);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .version {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    flex-shrink: 0;
  }

  /* ─── Pills ────────────────────────────────────────────────────────────── */

  .pill {
    align-items: center;
    block-size: 18px;
    border: 1px solid transparent;
    border-radius: 3px;
    display: inline-flex;
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    gap: 3px;
    line-height: 1;
    padding: 0 var(--size-1-5);
    white-space: nowrap;
  }

  .pill-neutral {
    background: var(--color-surface-3);
    border-color: var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .pill-job {
    background: color-mix(in srgb, var(--color-accent), transparent 85%);
    border-color: color-mix(in srgb, var(--color-accent), transparent 65%);
    color: var(--color-accent);
    font-family: var(--font-family-sans);
  }

  .pill-workspace {
    background: color-mix(in srgb, var(--color-success), transparent 88%);
    border-color: color-mix(in srgb, var(--color-success), transparent 68%);
    color: var(--color-success);
    font-family: var(--font-family-sans);
  }

  .pill-friday {
    background: color-mix(in srgb, var(--color-warning), transparent 88%);
    border-color: color-mix(in srgb, var(--color-warning), transparent 68%);
    color: var(--color-warning);
    font-family: var(--font-family-sans);
  }

  .pill-yaml {
    background: color-mix(in srgb, var(--color-warning), transparent 88%);
    border-color: color-mix(in srgb, var(--color-warning), transparent 68%);
    color: var(--color-warning);
    font-family: var(--font-family-monospace);
    letter-spacing: 0.02em;
  }


  /* ─── Actions ──────────────────────────────────────────────────────────── */

  .row-action {
    border-radius: var(--radius-1);
    font-size: var(--font-size-1);
    flex-shrink: 0;
    padding: 2px var(--size-3);
    transition: background 80ms ease, border-color 80ms ease;
  }

  .row-action:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .row-action.attach {
    background: color-mix(in srgb, var(--color-accent), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-accent), transparent 65%);
    color: var(--color-accent);
    font-weight: 500;
  }
  .row-action.attach:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent), transparent 72%);
  }

  .row-action.detach {
    background: transparent;
    border: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 35%);
  }
  .row-action.detach:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
    border-color: color-mix(in srgb, var(--color-text), transparent 70%);
    color: var(--color-text);
  }

  .row-locked {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    display: inline-flex;
    flex-shrink: 0;
    padding: 0 var(--size-2);
  }

  /* ─── Empty states ─────────────────────────────────────────────────────── */

  .empty {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-10) 0;
    text-align: center;
  }
  .empty.inline { padding: var(--size-6) 0; }
  .empty p {
    color: var(--color-text);
    font-size: var(--font-size-4);
    margin: 0;
  }
  .empty .hint {
    font-size: var(--font-size-2);
    opacity: 0.8;
  }

  /* ─── Drawer ───────────────────────────────────────────────────────────── */

  .drawer-overlay {
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
    inset: 0;
    padding: 0;
    position: fixed;
    z-index: 50;
  }

  .drawer {
    background: var(--color-surface-1);
    block-size: 100%;
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: min(480px, 96vw);
    inset-block: 0;
    inset-inline-end: 0;
    overflow-y: auto;
    padding: var(--size-5);
    position: fixed;
    z-index: 51;
  }

  .drawer-head {
    align-items: flex-start;
    display: flex;
    justify-content: space-between;
  }

  .drawer-kicker {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    letter-spacing: 0.06em;
    margin-block-end: var(--size-1);
    text-transform: uppercase;
  }

  .drawer-title {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-6);
  }
  .drawer-title .dim {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }
  .drawer-title .solid { color: var(--color-text); font-weight: 500; }

  .drawer-close {
    background: transparent;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-5);
    padding: var(--size-1);
  }

  .drawer-desc {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-3);
    line-height: 1.55;
    padding: var(--size-3) var(--size-4);
  }

  /* Most skill descriptions are authored markdown (bold, lists, inline
     code, paragraphs) — style them so they read like prose rather than a
     single wrapped blob. Scoped to .drawer-desc.markdown-body so it
     doesn't leak into other markdown surfaces. */
  .drawer-desc.markdown-body :global(p) {
    margin: 0 0 var(--size-2);
  }
  .drawer-desc.markdown-body :global(p:last-child) {
    margin-block-end: 0;
  }
  .drawer-desc.markdown-body :global(ul),
  .drawer-desc.markdown-body :global(ol) {
    margin: 0 0 var(--size-2);
    padding-inline-start: var(--size-5);
  }
  .drawer-desc.markdown-body :global(li) {
    margin-block-end: var(--size-1);
  }
  .drawer-desc.markdown-body :global(li) :global(p) {
    margin: 0;
  }
  .drawer-desc.markdown-body :global(strong) {
    color: var(--color-text);
    font-weight: 600;
  }
  .drawer-desc.markdown-body :global(code) {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: 0.9em;
    padding: 1px 4px;
  }
  .drawer-desc.markdown-body :global(pre) {
    background: var(--color-surface-3);
    border-radius: var(--radius-2);
    margin: 0 0 var(--size-2);
    overflow-x: auto;
    padding: var(--size-2-5) var(--size-3);
  }
  .drawer-desc.markdown-body :global(pre) :global(code) {
    background: transparent;
    padding: 0;
  }
  .drawer-desc.markdown-body :global(h1),
  .drawer-desc.markdown-body :global(h2),
  .drawer-desc.markdown-body :global(h3),
  .drawer-desc.markdown-body :global(h4) {
    font-size: var(--font-size-4);
    font-weight: 600;
    margin: var(--size-2) 0 var(--size-1);
  }
  .drawer-desc.markdown-body :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .drawer-desc.markdown-body :global(blockquote) {
    border-inline-start: 2px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    margin: 0 0 var(--size-2);
    padding-inline-start: var(--size-3);
  }

  .drawer-meta {
    column-gap: var(--size-4);
    display: grid;
    font-size: var(--font-size-2);
    grid-template-columns: auto 1fr;
    row-gap: var(--size-2);
  }
  .drawer-meta dt {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }
  .drawer-meta dd {
    font-family: var(--font-family-monospace);
    margin: 0;
  }

  .drawer-foot {
    margin-block-start: auto;
    padding-block-start: var(--size-3);
  }
  .drawer-link {
    color: var(--color-accent);
    font-size: var(--font-size-3);
    text-decoration: none;
  }
  .drawer-link:hover { text-decoration: underline; }
</style>
