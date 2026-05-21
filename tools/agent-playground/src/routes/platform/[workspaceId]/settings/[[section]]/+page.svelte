<!--
  Workspace settings page — identity and agent-environment sections.

  Two-pane list/detail layout: a section list on the left, the selected
  section's editor on the right. Identity edits the `workspace:` block
  (name / description / timeout) via the config route. The agent-environment
  section edits the *values* of each agent's env-backed keys, writing to the
  workspace `.env`; the wiring itself (which keys an agent reads, and whether
  they resolve from `.env` vs a linked credential) is authored in
  workspace.yml and shown read-only here.

  The MCP section composes onto this same page as another list entry.

  @component
-->

<script lang="ts">
  import { deriveWorkspaceAgents } from "@atlas/config/workspace-agents";
  import { Button, Icons, ListDetail, toast } from "@atlas/ui";
  import { variableEnvKey } from "@atlas/workspace";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceMcpSection from "$lib/components/mcp/workspace-mcp-section.svelte";
  import WorkspaceVariablesFields from "$lib/components/settings/workspace-variables-fields.svelte";
  import {
    SaveWorkspaceDetailsError,
    useSaveWorkspaceDetails,
    useSetWorkspaceEnvVar,
    workspaceEnvQueries,
    workspaceQueries,
    workspaceVariableQueries,
  } from "$lib/queries";
  import {
    buildIdentityPatch,
    identityDirty as deriveIdentityDirty,
    pruneLandedEdits,
    seedIdentityFromConfig,
    splitVariableEdits,
    summarizeCommitResults,
    variablesDirty as deriveVariablesDirty,
    type VariableEdits,
  } from "$lib/workspace-variables/details-state.ts";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  // List/detail layout — one settings section per list entry. The active
  // section is driven by the URL: `settings` (no slug) → identity,
  // `settings/agent-environment`, `settings/mcp`. The slug doubles as the
  // route segment so nav is just `<a href>` and back/forward works for free.
  type SettingsSection = "identity" | "agent-environment" | "mcp";
  const SECTIONS: { id: SettingsSection; slug: string; label: string; blurb: string }[] = [
    { id: "identity", slug: "", label: "Workspace Details", blurb: "Name, description, timeouts" },
    {
      id: "agent-environment",
      slug: "agent-environment",
      label: "Agent environment",
      blurb: "Per-agent env values",
    },
    { id: "mcp", slug: "mcp", label: "MCP servers", blurb: "Per-server settings & credentials" },
  ];
  const SECTION_IDS = new Set<SettingsSection>(["identity", "agent-environment", "mcp"]);
  const activeSection = $derived.by<SettingsSection>(() => {
    const slug = page.params.section;
    if (!slug) return "identity";
    return SECTION_IDS.has(slug as SettingsSection) ? (slug as SettingsSection) : "identity";
  });
  const settingsBasePath = $derived(workspaceId ? `/platform/${workspaceId}/settings` : null);

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const envQuery = createQuery(() => workspaceEnvQueries.list(workspaceId));
  const variablesQuery = createQuery(() => workspaceVariableQueries.list(workspaceId));

  const config = $derived(configQuery.data?.config ?? null);

  // ── Identity + Variables section ───────────────────────────────────────
  // One form, one Save / Discard pair, one composite mutation. Identity
  // inputs and the variables edits map are seeded together off the same
  // `seededFor` sentinel so a config refetch and a variables refetch each
  // re-seed exactly once per genuine data update — same-timestamp
  // background refetches preserve in-flight user edits (test #8).
  const identity = $derived(
    (config?.workspace as
      | {
          name?: string;
          description?: string;
          timeout?: { progressTimeout?: string; maxTotalTimeout?: string };
        }
      | undefined) ?? null,
  );
  const identitySeed = $derived(seedIdentityFromConfig(identity));
  const variables = $derived(variablesQuery.data ?? []);

  let nameInput = $state("");
  let descriptionInput = $state("");
  let progressTimeoutInput = $state("");
  let maxTotalTimeoutInput = $state("");
  let variableEdits = $state<VariableEdits>({});
  let variableErrors = $state<Record<string, string | undefined>>({});

  // Re-seed identity inputs whenever fresh config arrives. The stamp
  // includes `configQuery.dataUpdatedAt` so refetches at the same
  // timestamp don't reseed — that's the dirty-edit preservation guarantee.
  let identitySeededFor = "";
  $effect(() => {
    if (!identity || !workspaceId) return;
    const stamp = `${workspaceId}:${configQuery.dataUpdatedAt}`;
    if (identitySeededFor === stamp) return;
    identitySeededFor = stamp;
    nameInput = identitySeed.name;
    descriptionInput = identitySeed.description;
    progressTimeoutInput = identitySeed.progressTimeout;
    maxTotalTimeoutInput = identitySeed.maxTotalTimeout;
  });

  // Re-seed the variables edits map on a genuine variables refetch. Same
  // `seededFor`-stamp pattern — background refetches at the same
  // `dataUpdatedAt` preserve user edits (test #8).
  let variablesSeededFor = "";
  $effect(() => {
    if (!workspaceId) return;
    if (variablesQuery.dataUpdatedAt === 0) return;
    const stamp = `${workspaceId}:${variablesQuery.dataUpdatedAt}`;
    if (variablesSeededFor === stamp) return;
    variablesSeededFor = stamp;
    variableEdits = {};
    variableErrors = {};
  });

  const identityDirty = $derived(
    !!identity &&
      deriveIdentityDirty(
        {
          name: nameInput,
          description: descriptionInput,
          progressTimeout: progressTimeoutInput,
          maxTotalTimeout: maxTotalTimeoutInput,
        },
        identitySeed,
      ),
  );
  const variablesDirty = $derived(deriveVariablesDirty(variableEdits, variables));
  const hasFieldErrors = $derived(Object.values(variableErrors).some((v) => v !== undefined));

  const saveDetails = useSaveWorkspaceDetails();

  function discardChanges(): void {
    nameInput = identitySeed.name;
    descriptionInput = identitySeed.description;
    progressTimeoutInput = identitySeed.progressTimeout;
    maxTotalTimeoutInput = identitySeed.maxTotalTimeout;
    variableEdits = {};
    variableErrors = {};
  }

  function handleVariableChange(name: string, value: string | null): void {
    variableEdits = { ...variableEdits, [name]: value };
    // Editing clears that field's error so the user can retry without
    // a stale pre-flight message yelling at them mid-keystroke.
    if (variableErrors[name] !== undefined) {
      const { [name]: _cleared, ...rest } = variableErrors;
      variableErrors = rest;
    }
  }

  async function saveDetailsClick(): Promise<void> {
    if (!workspaceId || !identity) return;
    if (!identityDirty && !variablesDirty) return;

    const patchResult = buildIdentityPatch(
      {
        name: nameInput,
        description: descriptionInput,
        progressTimeout: progressTimeoutInput,
        maxTotalTimeout: maxTotalTimeoutInput,
      },
      identitySeed,
    );
    if (patchResult.kind === "error") {
      toast({ title: patchResult.message, error: true });
      return;
    }

    const { variableSets, variableDeletes } = splitVariableEdits(variableEdits);

    try {
      await saveDetails.mutateAsync({
        workspaceId,
        ...(patchResult.patch !== undefined ? { identityPatch: patchResult.patch } : {}),
        variableSets,
        variableDeletes,
      });
      toast({ title: "Workspace details saved" });
    } catch (e) {
      if (e instanceof SaveWorkspaceDetailsError) {
        variableErrors = { ...variableErrors, ...e.fieldErrors };
        if (e.commitResults !== undefined) {
          variableEdits = pruneLandedEdits(
            variableEdits,
            e.commitResults,
            variableEnvKey,
          );
          toast({
            title: "Some changes did not save",
            description: summarizeCommitResults(e.commitResults),
            error: true,
          });
        } else {
          toast({ title: "Save failed", description: e.message, error: true });
        }
      } else {
        const err = e instanceof Error ? e : new Error(String(e));
        toast({ title: "Save failed", description: err.message, error: true });
      }
    }
  }

  // ── Agent environment section ──────────────────────────────────────────
  /** Key-name heuristic — kept in sync with the env tools' shared.ts. */
  const SECRET_KEY_RE = /password|secret|token|key|credential/i;
  const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key);

  type EnvWiring =
    | { kind: "env-backed" } // resolves from `.env` — value is editable here
    | { kind: "literal"; value: string } // literal value in workspace.yml — read-only
    | { kind: "link" }; // linked credential — read-only, managed elsewhere

  function classifyWiring(raw: unknown): EnvWiring {
    if (typeof raw === "string") {
      if (raw === "from_environment" || raw === "auto") return { kind: "env-backed" };
      return { kind: "literal", value: raw };
    }
    return { kind: "link" };
  }

  const agents = $derived(config ? deriveWorkspaceAgents(config) : []);
  const agentsWithEnv = $derived(
    agents
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.agent ?? agent.type,
        entries: Object.entries(agent.env).map(([key, raw]) => ({
          key,
          wiring: classifyWiring(raw),
        })),
      }))
      .filter((a) => a.entries.length > 0),
  );

  const envMap = $derived(envQuery.data ?? {});

  // Per-key edit + reveal state, keyed by env var name (values are shared
  // workspace-wide, so editing is keyed by name, not by agent).
  let edits = $state<Record<string, string>>({});
  let revealed = $state<Record<string, boolean>>({});

  function currentValue(key: string): string {
    return edits[key] ?? envMap[key] ?? "";
  }
  function isKeyDirty(key: string): boolean {
    return key in edits && edits[key] !== (envMap[key] ?? "");
  }

  const setEnvVar = useSetWorkspaceEnvVar();
  let savingKey = $state<string | null>(null);

  async function saveEnvKey(key: string): Promise<void> {
    if (!workspaceId || !isKeyDirty(key)) return;
    savingKey = key;
    try {
      await setEnvVar.mutateAsync({ workspaceId, key, value: edits[key] ?? "" });
      const { [key]: _saved, ...rest } = edits;
      edits = rest;
      toast({ title: `${key} saved` });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: `Failed to save ${key}`, description: err.message, error: true });
    } finally {
      savingKey = null;
    }
  }
</script>

<ListDetail>
  {#snippet header()}
    <h1>Settings</h1>
  {/snippet}

  {#snippet sidebar()}
    <nav class="section-nav">
      {#each SECTIONS as section (section.id)}
        <a
          class="section-nav-item"
          class:active={activeSection === section.id}
          href={settingsBasePath
            ? section.slug
              ? `${settingsBasePath}/${section.slug}`
              : settingsBasePath
            : "#"}
          aria-current={activeSection === section.id ? "page" : undefined}
        >
          <span class="section-nav-label">{section.label}</span>
          <span class="section-nav-blurb">{section.blurb}</span>
        </a>
      {/each}
    </nav>
  {/snippet}

  <div class="settings-detail">
    {#if configQuery.isLoading}
      <div class="empty-state"><p>Loading workspace settings…</p></div>
    {:else if configQuery.isError}
      <div class="empty-state">
        <p>Failed to load workspace settings</p>
        <span class="empty-hint">{configQuery.error?.message ?? ""}</span>
      </div>
    {:else if activeSection === "identity"}
      <!-- ── Identity ──────────────────────────────────────────────────── -->
      <section class="section">
        <header>
          <h2>Workspace Details</h2>
          <p class="section-sub">
            Name, description, and operation timeouts for this workspace.
          </p>
        </header>

        <div class="form-grid">
          <label class="field">
            <span class="field-label">Name</span>
            <input
              class="text-input"
              type="text"
              bind:value={nameInput}
              placeholder="Workspace name"
              autocomplete="off"
            />
          </label>

          <label class="field">
            <span class="field-label">Description</span>
            <textarea
              class="text-input"
              bind:value={descriptionInput}
              placeholder="What this workspace is for"
              rows="2"
            ></textarea>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">Progress timeout</span>
              <input
                class="text-input mono"
                type="text"
                bind:value={progressTimeoutInput}
                placeholder="2m"
                autocomplete="off"
              />
            </label>
            <label class="field">
              <span class="field-label">Max total timeout</span>
              <input
                class="text-input mono"
                type="text"
                bind:value={maxTotalTimeoutInput}
                placeholder="30m"
                autocomplete="off"
              />
            </label>
          </div>
          <p class="field-hint">
            Durations accept values like <code>30s</code>, <code>2m</code>, <code>1h</code>. Leave
            both blank to use the defaults.
          </p>

          {#if variablesQuery.data && variablesQuery.data.length > 0}
            <WorkspaceVariablesFields
              variables={variablesQuery.data}
              values={variableEdits}
              errors={variableErrors}
              onChange={handleVariableChange}
            />
          {/if}
        </div>

        <div class="actions">
          <Button
            variant="primary"
            onclick={saveDetailsClick}
            disabled={(!identityDirty && !variablesDirty) ||
              saveDetails.isPending ||
              hasFieldErrors}
          >
            {saveDetails.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="secondary"
            onclick={discardChanges}
            disabled={!identityDirty && !variablesDirty}
          >
            Discard
          </Button>
        </div>
      </section>
    {:else if activeSection === "agent-environment"}
      <!-- ── Agent environment ─────────────────────────────────────────── -->
      <section class="section">
        <header>
          <h2>Agent environment</h2>
          <p class="section-sub">
            Values for each agent's environment-backed keys. Values are stored in this
            workspace's <code>.env</code> and shared by name across agents and MCP servers.
            Linked credentials and literal values are authored in <code>workspace.yml</code>
            and shown read-only.
          </p>
        </header>

        {#if agentsWithEnv.length === 0}
          <p class="empty-hint">No agents in this workspace declare environment variables.</p>
        {:else}
          {#if envQuery.isError}
            <div class="error-banner" role="alert">
              <span>Failed to load workspace .env: {envQuery.error?.message ?? ""}</span>
              <button type="button" class="retry" onclick={() => envQuery.refetch()}>
                Retry
              </button>
            </div>
          {/if}
          <div class="agent-list">
            {#each agentsWithEnv as agent (agent.id)}
              <div class="agent-block">
                <div class="agent-head">
                  <span class="agent-name">{agent.name}</span>
                  <span class="agent-type">{agent.type}</span>
                </div>
                <div class="env-rows">
                  {#each agent.entries as entry (entry.key)}
                    <div class="env-row">
                      <code class="env-key">{entry.key}</code>
                      {#if entry.wiring.kind === "env-backed"}
                        {@const secret = isSecretKey(entry.key)}
                        <input
                          class="env-value"
                          type={secret && !revealed[entry.key] ? "password" : "text"}
                          value={currentValue(entry.key)}
                          oninput={(e) => {
                            edits = { ...edits, [entry.key]: e.currentTarget.value };
                          }}
                          placeholder={envQuery.isLoading ? "Loading…" : "Not set"}
                          autocomplete="off"
                          spellcheck="false"
                        />
                        {#if secret}
                          <button
                            type="button"
                            class="reveal"
                            aria-label={revealed[entry.key] ? "Hide value" : "Show value"}
                            onclick={() => {
                              revealed = { ...revealed, [entry.key]: !revealed[entry.key] };
                            }}
                          >
                            {#if revealed[entry.key]}<Icons.Eye />{:else}<Icons.EyeClosed />{/if}
                          </button>
                        {/if}
                        <Button
                          variant="secondary"
                          onclick={() => saveEnvKey(entry.key)}
                          disabled={!isKeyDirty(entry.key) || savingKey === entry.key}
                        >
                          {savingKey === entry.key ? "Saving…" : "Save"}
                        </Button>
                      {:else if entry.wiring.kind === "link"}
                        <span class="env-readonly">
                          <span class="badge">Linked credential</span>
                          managed in workspace.yml
                        </span>
                      {:else}
                        <span class="env-readonly">
                          <span class="badge">Literal</span>
                          value set in workspace.yml
                        </span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {:else if activeSection === "mcp" && workspaceId}
      <WorkspaceMcpSection {workspaceId} />
    {/if}
  </div>
</ListDetail>

<style>
  .section-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    /* Breathing room so a focused item's outline isn't clipped by the
       ListDetail sidebar's overflow (it has no block-end padding). */
    padding: var(--size-1) var(--size-1) var(--size-3);
  }

  .section-nav-item {
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--size-2) var(--size-2-5);
    text-align: start;
    text-decoration: none;
    transition: background-color 0.12s ease;
  }

  .section-nav-item:hover:not(.active) {
    background-color: color-mix(in srgb, var(--text), transparent 92%);
  }

  .section-nav-item.active {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
  }

  .section-nav-label {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .section-nav-blurb {
    color: color-mix(in srgb, var(--text), transparent 45%);
    font-size: var(--font-size-2);
  }

  .settings-detail {
    display: flex;
    flex-direction: column;
    padding: var(--size-10) var(--size-12);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    max-inline-size: 80ch;
  }

  .section > header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section h2 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-sub {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
    max-inline-size: 70ch;
  }

  .section-sub code,
  .field-hint code {
    font-size: var(--font-size-2);
  }

  .form-grid {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    max-inline-size: 60ch;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field-row {
    display: flex;
    gap: var(--size-3);
  }

  .field-row .field {
    flex: 1;
  }

  .field-label {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .field-hint {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
  }

  .text-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
  }

  .text-input.mono {
    font-family: var(--font-family-mono, ui-monospace, monospace);
  }

  textarea.text-input {
    resize: vertical;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .agent-block {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .agent-head {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .agent-name {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .agent-type {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--text), transparent 30%);
    font-size: var(--font-size-1, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-2);
  }

  .env-rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .env-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .env-key {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-3);
    inline-size: 26ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-value {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    flex: 1;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-3);
    min-inline-size: 0;
    padding: var(--size-1) var(--size-1-5);
  }

  .reveal {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 16px;
    block-size: 16px;
    padding: 0;
  }

  .reveal :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .env-readonly {
    color: var(--text);
    display: flex;
    flex: 1;
    gap: var(--size-2);
    font-size: var(--font-size-3);
  }

  .badge {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-1, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
  }

  .empty-state,
  .empty-hint {
    color: var(--text);
    font-size: var(--font-size-3);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-8) 0;
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background-color: color-mix(in srgb, var(--red-primary), transparent 90%);
    border: 1px solid color-mix(in srgb, var(--red-primary), transparent 65%);
    border-radius: var(--radius-2);
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-2);
    justify-content: space-between;
    padding: var(--size-2) var(--size-3);
  }

  .retry {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    cursor: pointer;
    font-size: var(--font-size-1, 11px);
    padding: var(--size-0-5) var(--size-2);
  }
</style>
