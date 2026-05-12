<!--
  Skill detail page — renders SKILL.md as markdown preview or CodeMirror editor.
  Shown when a skill is expanded in the tree but no specific reference file is selected.

  @component
-->

<script lang="ts">
  import { browser } from "$app/environment";
  import {
    Button,
    Dialog,
    DropdownMenu,
    Icons,
    MarkdownRendered,
    markdownToHTML,
    toast,
  } from "@atlas/ui";
  import DOMPurify from "dompurify";
  import { createQuery } from "@tanstack/svelte-query";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import SkillFileEditor from "$lib/components/skills/skill-file-editor.svelte";
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import VersionCompareDialog from "$lib/components/skills/version-compare-dialog.svelte";
  import { skillQueries } from "$lib/queries";
  import {
    FIXABLE_RULES,
    useAutofixSkill,
    useCheckSkillUpdate,
    useDeleteSkill,
    useDisableSkill,
    usePublishSkill,
    useRestoreSkillVersion,
    useSkillLint,
    useSkillVersions,
    useUpdateSkillFromSource,
  } from "$lib/queries/skills";
  import { markClean, markDirty } from "$lib/stores/skill-editor-state.svelte";
  import { writable } from "svelte/store";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");

  const skillQuery = createQuery(() => ({
    ...skillQueries.detail(namespace, name),
    enabled: namespace.length > 0 && name.length > 0,
  }));

  const skill = $derived(skillQuery.data?.skill);

  /** Rebase relative hrefs so they resolve under the skill's own path segment. */
  function rebaseRelativeLinks(html: string): string {
    const base = `/skills/${namespace}/${name}/`;
    return html.replace(/href="(?!https?:\/\/|#|\/|mailto:)/g, `href="${base}`);
  }

  // ---------------------------------------------------------------------------
  // Edit mode (URL-driven via ?edit query param)
  // ---------------------------------------------------------------------------

  const editing = $derived(page.url.searchParams.has("edit"));
  let editorDirty = $state(false);
  let editorContent = $state("");

  function startEditing() {
    goto("?edit");
  }

  const publishMut = usePublishSkill();

  function handleSave(content: string) {
    if (!skill || publishMut.isPending) return;
    publishMut.mutate(
      {
        namespace,
        name,
        instructions: content,
        description: skill.description ?? undefined,
        descriptionManual: true,
      },
      {
        onSuccess: () => {
          markClean("SKILL.md");
          editorDirty = false;
          goto(page.url.pathname);
        },
        onError: (err: Error) => {
          toast({ title: "Failed to save SKILL.md", description: err.message, error: true });
        },
      },
    );
  }

  function handleCancel() {
    markClean("SKILL.md");
    editorDirty = false;
    goto(page.url.pathname);
  }

  function handleDirtyChange(dirty: boolean) {
    editorDirty = dirty;
    if (dirty) {
      markDirty("SKILL.md");
    } else {
      markClean("SKILL.md");
    }
  }

  // Navigation guards
  beforeNavigate(({ cancel }) => {
    if (editorDirty) {
      const confirmed = confirm("You have unsaved changes. Discard them?");
      if (!confirmed) {
        cancel();
        return;
      }
      markClean("SKILL.md");
      editorDirty = false;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (editorDirty) e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Enable / Disable toggle
  // ---------------------------------------------------------------------------

  const disableMut = useDisableSkill();

  function toggleDisabled() {
    if (!skill || disableMut.isPending) return;
    disableMut.mutate({ skillId: skill.skillId, disabled: !skill.disabled });
  }

  // ---------------------------------------------------------------------------
  // Delete skill
  // ---------------------------------------------------------------------------

  const deleteMut = useDeleteSkill();
  const deleteDialogOpen = writable(false);
  let deleteChecking = $state(false);

  async function findWorkspacesUsing(ns: string, skillName: string): Promise<string[]> {
    const ref = `@${ns}/${skillName}`;
    const listRes = await fetch("/api/daemon/api/workspaces");
    if (!listRes.ok) return [];
    const workspaces: Array<{ id: string; name: string }> = await listRes.json();

    const using: string[] = [];
    for (const ws of workspaces) {
      const cfgRes = await fetch(`/api/daemon/api/workspaces/${ws.id}/config`);
      if (!cfgRes.ok) continue;
      const { config } = await cfgRes.json();
      const skills: Array<{ name?: string }> = config?.skills ?? [];
      if (skills.some((s) => s.name === ref)) {
        using.push(ws.name ?? ws.id);
      }
    }
    return using;
  }

  async function handleDeleteClick() {
    if (!skill || deleteChecking) return;
    deleteChecking = true;

    const using = await findWorkspacesUsing(namespace, name);
    deleteChecking = false;

    if (using.length > 0) {
      toast({
        title: "Skill is in use",
        description: `Remove it from ${using.join(", ")} first, then try again.`,
        error: true,
      });
      return;
    }

    deleteDialogOpen.set(true);
  }

  function confirmDelete() {
    if (!skill || deleteMut.isPending) return;
    deleteMut.mutate(skill.skillId, {
      onSuccess: () => {
        deleteDialogOpen.set(false);
        toast({ title: "Skill deleted", description: `@${namespace}/${name}` });
        goto("/skills");
      },
      onError: () => {
        toast({ title: "Failed to delete skill", error: true });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Upload new version
  // ---------------------------------------------------------------------------

  const uploadDialogOpen = writable(false);

  // ---------------------------------------------------------------------------
  // Lint — publish-time rules run on the stored skill; results render in a
  // collapsible panel so the user can see issues without leaving the page.
  // ---------------------------------------------------------------------------

  const lintQuery = useSkillLint(() => namespace, () => name);
  const lintIssueCount = $derived(
    (lintQuery.data?.errors.length ?? 0) + (lintQuery.data?.warnings.length ?? 0),
  );
  let lintOpen = $state(false);

  const autofixMut = useAutofixSkill();
  /** Which finding is actively being fixed — keyed by rule:message so the
   *  button only spins on the row the user clicked. */
  let fixingKey = $state<string | null>(null);

  async function handleFix(rule: string, message: string) {
    const key = `${rule}:${message}`;
    if (fixingKey !== null) return;
    fixingKey = key;
    try {
      const res = await autofixMut.mutateAsync({ namespace, name, rule });
      toast({
        title: "Lint fix applied",
        description: `${rule} — fixed via ${res.fixedBy}; published as v${String(res.published.version)}.`,
      });
    } catch (e) {
      toast({ title: "Fix failed", description: (e as Error).message, error: true });
    } finally {
      fixingKey = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Version history — every Save publishes a new row; this lists them and
  // lets the user restore an older snapshot as a new version.
  // ---------------------------------------------------------------------------

  const versionsQuery = useSkillVersions(() => namespace, () => name);
  const restoreMut = useRestoreSkillVersion();

  function formatVersionDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "2-digit",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /**
   * Target of the compare dialog, stamped with the namespace/name it was
   * opened for. Keying on the tuple means navigating to a different skill
   * causes `compareVersion` below to evaluate to `null` synchronously —
   * no race where the dialog stays mounted and the child fetches the
   * wrong version (which 404s if the new skill has fewer revisions).
   */
  let compareState = $state<{ ns: string; name: string; version: number } | null>(null);
  const compareVersion = $derived(
    compareState && compareState.ns === namespace && compareState.name === name
      ? compareState.version
      : null,
  );

  function openCompare(version: number) {
    if (version === skill?.version) return;
    compareState = { ns: namespace, name, version };
  }

  function closeCompare() {
    compareState = null;
  }

  async function handleRestore(version: number) {
    if (restoreMut.isPending) return;
    try {
      const res = await restoreMut.mutateAsync({ namespace, name, version });
      toast({
        title: "Version restored",
        description: `Snapshot of v${String(version)} published as v${String(res.published.version)}.`,
      });
      compareState = null;
    } catch (e) {
      toast({ title: "Restore failed", description: (e as Error).message, error: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Pull from skills.sh source (only applies to remotely-installed skills)
  // ---------------------------------------------------------------------------

  const checkUpdateMut = useCheckSkillUpdate();
  const updateSourceMut = useUpdateSkillFromSource();

  /** Skills.sh provenance — populated from frontmatter when the skill was installed from a remote. */
  const sourceRef = $derived.by(() => {
    const raw = skill?.frontmatter?.source;
    return typeof raw === "string" && raw.startsWith("skills.sh/") ? raw : null;
  });
  /** Public skills.sh URL for the provenance link — swap the leading
   *  `skills.sh/` segment for `https://skills.sh/` and keep the rest of
   *  the path intact. */
  const sourceUrl = $derived(sourceRef ? `https://${sourceRef}` : null);

  async function handleCheckUpdate() {
    if (!skill || checkUpdateMut.isPending) return;
    try {
      const res = await checkUpdateMut.mutateAsync({ namespace, name });
      if (res.hasUpdate) {
        toast({
          title: "Update available",
          description: `A new version of @${namespace}/${name} is on skills.sh.`,
        });
      } else {
        toast({ title: "Up to date", description: `@${namespace}/${name} matches skills.sh.` });
      }
    } catch (e) {
      const err = e as Error;
      toast({ title: "Update check failed", description: err.message, error: true });
    }
  }

  async function handlePullUpdate() {
    if (!skill || updateSourceMut.isPending) return;
    try {
      const res = await updateSourceMut.mutateAsync({ namespace, name });
      toast({
        title: "Skill updated",
        description: `@${namespace}/${name} is now v${String(res.updated.version)}.`,
      });
    } catch (e) {
      const err = e as Error;
      toast({ title: "Update failed", description: err.message, error: true });
    }
  }
</script>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div class="skill-detail">
  {#if skillQuery.isLoading}
    <div class="loading-state">
      <p>Loading skill...</p>
    </div>
  {:else if skillQuery.isError}
    <div class="loading-state">
      <p>Failed to load skill</p>
      <span class="error-hint">Could not fetch @{namespace}/{name}</span>
    </div>
  {:else if skill}
    <div class="page-actions">
      {#if editing}
        <Button size="small" variant="secondary" onclick={handleCancel}>Cancel</Button>
        <Button
          size="small"
          variant={editorDirty ? "primary" : "secondary"}
          onclick={() => handleSave(editorContent)}
          disabled={!editorDirty || publishMut.isPending}
        >
          {publishMut.isPending ? "Saving…" : "Save"}
        </Button>
      {:else}
        {#if skill}
          <span class="version-badge" title={`Published v${String(skill.version)} · ${String(versionsQuery.data?.length ?? "?")} total`}>v{skill.version}</span>
        {/if}
        {#if (versionsQuery.data?.length ?? 0) > 1}
          <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
            {#snippet children()}
              <DropdownMenu.Trigger class="versions-trigger">
                History
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {#each versionsQuery.data ?? [] as v (v.version)}
                  <DropdownMenu.Item
                    onclick={() => {
                      openCompare(v.version);
                    }}
                    disabled={v.version === skill?.version}
                  >
                    v{v.version} · {formatVersionDate(v.createdAt)}{v.version === skill?.version
                      ? " (current)"
                      : " — compare"}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            {/snippet}
          </DropdownMenu.Root>
        {/if}
        {#if lintIssueCount > 0}
          <Button
            size="small"
            variant={(lintQuery.data?.errors.length ?? 0) > 0 ? "primary" : "secondary"}
            onclick={() => {
              lintOpen = !lintOpen;
            }}
          >
            {lintIssueCount} issue{lintIssueCount === 1 ? "" : "s"}
          </Button>
        {/if}
        {#if sourceRef && sourceUrl}
          <a
            class="source-hint"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={sourceRef}
          >
            from skills.sh ↗
          </a>
          <Button
            size="small"
            variant="secondary"
            onclick={handleCheckUpdate}
            disabled={checkUpdateMut.isPending}
          >
            {checkUpdateMut.isPending ? "Checking…" : "Check for updates"}
          </Button>
          {#if checkUpdateMut.data?.hasUpdate}
            <Button
              size="small"
              variant="primary"
              onclick={handlePullUpdate}
              disabled={updateSourceMut.isPending}
            >
              {updateSourceMut.isPending ? "Updating…" : "Update"}
            </Button>
          {/if}
        {/if}
        <Button size="small" variant="secondary" onclick={startEditing}>Edit</Button>

        <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
          {#snippet children()}
            <DropdownMenu.Trigger class="more-trigger" aria-label="More options">
              <Icons.TripleDots />
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              <DropdownMenu.Item onclick={toggleDisabled}>
                {disableMut.isPending
                  ? skill.disabled
                    ? "Enabling..."
                    : "Disabling..."
                  : skill.disabled
                    ? "Enable"
                    : "Disable"}
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => uploadDialogOpen.set(true)}>
                Replace
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onclick={() => {
                  window.location.href = `/api/daemon/api/skills/@${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/export`;
                }}
              >
                Export
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="delete-item" onclick={handleDeleteClick}>
                {deleteChecking ? "Checking..." : "Remove skill"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          {/snippet}
        </DropdownMenu.Root>

        {#if disableMut.isError}
          <span class="action-error">Failed to update</span>
        {/if}
      {/if}
    </div>

    {#if lintOpen && lintQuery.data}
      <div class="lint-panel">
        {#each [...lintQuery.data.errors, ...lintQuery.data.warnings] as f (f.rule + f.message)}
          {@const canFix = FIXABLE_RULES.has(f.rule)}
          {@const key = `${f.rule}:${f.message}`}
          <div class="lint-row lint-{f.severity}">
            <span class="lint-severity">{f.severity}</span>
            <span class="lint-rule">{f.rule}</span>
            <span class="lint-msg">{f.message}</span>
            {#if canFix}
              <button
                class="lint-fix"
                disabled={fixingKey !== null}
                onclick={() => handleFix(f.rule, f.message)}
              >
                {fixingKey === key ? "Fixing…" : "Fix"}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if editing}
      <div class="editor-pane">
        <SkillFileEditor
          content={skill.instructions ?? ""}
          bind:editedContent={editorContent}
          onsave={handleSave}
          oncancel={handleCancel}
          ondirtychange={handleDirtyChange}
        />
      </div>
    {:else}
      <div class="preview-content">
        <MarkdownRendered>
          {@html browser ? DOMPurify.sanitize(rebaseRelativeLinks(markdownToHTML(skill.instructions ?? ""))) : markdownToHTML(skill.instructions ?? "")}
        </MarkdownRendered>
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root open={deleteDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Delete skill</Dialog.Title>
        <Dialog.Description>
          Are you sure you want to delete <strong>@{namespace}/{name}</strong>
          ? This removes all versions and cannot be undone.
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <Dialog.Button onclick={confirmDelete} disabled={deleteMut.isPending} closeOnClick={false}>
          {deleteMut.isPending ? "Deleting..." : "Delete"}
        </Dialog.Button>
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<Dialog.Root open={uploadDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Update skill</Dialog.Title>
        <Dialog.Description>
          Replace <strong>@{namespace}/{name}</strong> with a new version.
        </Dialog.Description>
      {/snippet}

      <SkillLoader
        inline
        forceNamespace={namespace}
        forceName={name}
        onclose={() => uploadDialogOpen.set(false)}
      />

      {#snippet footer()}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

{#if compareVersion !== null && skill}
  <VersionCompareDialog
    {namespace}
    {name}
    currentVersion={skill.version}
    currentDescription={skill.description ?? ""}
    currentInstructions={skill.instructions ?? ""}
    targetVersion={compareVersion}
    restoring={restoreMut.isPending}
    onclose={closeCompare}
    onrestore={handleRestore}
  />
{/if}

<style>
  .skill-detail {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  .loading-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-16) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .error-hint {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  /* --- Page Actions -------------------------------------------------------- */

  .page-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    justify-content: flex-end;
    padding: var(--size-3) var(--size-6);
  }

  :global(.more-trigger) {
    align-items: center;
    background-color: var(--color-surface-2);
    block-size: var(--size-6);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--text-1);
    cursor: default;
    display: inline-flex;
    inline-size: var(--size-6);
    justify-content: center;
    transition: all 150ms ease;
    user-select: none;
    -webkit-user-select: none;
  }

  :global(.more-trigger:hover) {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
  }

  :global(.delete-item) {
    color: var(--color-error) !important;
  }

  .action-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .source-hint {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin-inline-end: var(--size-2);
    text-decoration: none;
    transition: color 120ms ease;
  }

  .source-hint:hover {
    color: var(--color-text);
    text-decoration: underline;
  }

  .version-badge {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 2px var(--size-1-5);
  }

  :global(.versions-trigger) {
    background-color: transparent;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  :global(.versions-trigger:hover) {
    background-color: var(--color-surface-2);
  }

  .lint-panel {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-3) var(--size-6) var(--size-4);
  }

  .lint-row {
    align-items: baseline;
    display: grid;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    grid-template-columns: auto auto 1fr auto;
  }

  .lint-fix {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: 2px var(--size-2);
  }

  .lint-fix:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 10%);
  }

  .lint-fix:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .lint-severity {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .lint-error .lint-severity {
    color: var(--color-error);
  }

  .lint-warn .lint-severity {
    color: var(--color-warning);
  }

  .lint-info .lint-severity {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .lint-rule {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-1);
  }

  .lint-msg {
    color: var(--color-text);
  }

  /* --- Editor / Preview ---------------------------------------------------- */

  .editor-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    padding: var(--size-4) 0;
  }

  .preview-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-2) var(--size-8) var(--size-6);
    scrollbar-width: thin;
  }
</style>
