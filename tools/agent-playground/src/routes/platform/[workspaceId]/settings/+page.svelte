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
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import {
    useSetWorkspaceEnvVar,
    useUpdateWorkspaceIdentity,
    workspaceEnvQueries,
    workspaceQueries,
  } from "$lib/queries";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  // List/detail layout — one settings section per list entry. The MCP
  // section composes on as its own entry separately.
  type SettingsSection = "identity" | "agent-env";
  const SECTIONS: { id: SettingsSection; label: string; blurb: string }[] = [
    { id: "identity", label: "Identity", blurb: "Name, description, timeouts" },
    { id: "agent-env", label: "Agent environment", blurb: "Per-agent env values" },
  ];
  let activeSection = $state<SettingsSection>("identity");

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const envQuery = createQuery(() => workspaceEnvQueries.list(workspaceId));

  const config = $derived(configQuery.data?.config ?? null);

  // ── Identity section ───────────────────────────────────────────────────
  const identity = $derived(
    (config?.workspace as
      | {
          name?: string;
          description?: string;
          timeout?: { progressTimeout?: string; maxTotalTimeout?: string };
        }
      | undefined) ?? null,
  );

  let nameInput = $state("");
  let descriptionInput = $state("");
  let progressTimeoutInput = $state("");
  let maxTotalTimeoutInput = $state("");

  // Re-seed the form whenever fresh config arrives (and after a save settles).
  let seededFor = "";
  $effect(() => {
    if (!identity || !workspaceId) return;
    const stamp = `${workspaceId}:${configQuery.dataUpdatedAt}`;
    if (seededFor === stamp) return;
    seededFor = stamp;
    nameInput = identity.name ?? "";
    descriptionInput = identity.description ?? "";
    progressTimeoutInput = identity.timeout?.progressTimeout ?? "";
    maxTotalTimeoutInput = identity.timeout?.maxTotalTimeout ?? "";
  });

  const identityDirty = $derived(
    !!identity &&
      (nameInput !== (identity.name ?? "") ||
        descriptionInput !== (identity.description ?? "") ||
        progressTimeoutInput !== (identity.timeout?.progressTimeout ?? "") ||
        maxTotalTimeoutInput !== (identity.timeout?.maxTotalTimeout ?? "")),
  );

  const updateIdentity = useUpdateWorkspaceIdentity();

  function resetIdentity(): void {
    if (!identity) return;
    nameInput = identity.name ?? "";
    descriptionInput = identity.description ?? "";
    progressTimeoutInput = identity.timeout?.progressTimeout ?? "";
    maxTotalTimeoutInput = identity.timeout?.maxTotalTimeout ?? "";
  }

  async function saveIdentity(): Promise<void> {
    if (!workspaceId || !identity || !identityDirty) return;
    if (nameInput.trim().length === 0) {
      toast({ title: "Name is required", error: true });
      return;
    }
    const patch: {
      name?: string;
      description?: string;
      timeout?: { progressTimeout: string; maxTotalTimeout: string };
    } = {};
    if (nameInput !== (identity.name ?? "")) patch.name = nameInput.trim();
    if (descriptionInput !== (identity.description ?? "")) patch.description = descriptionInput;
    const progress = progressTimeoutInput.trim();
    const maxTotal = maxTotalTimeoutInput.trim();
    if (
      progress !== (identity.timeout?.progressTimeout ?? "") ||
      maxTotal !== (identity.timeout?.maxTotalTimeout ?? "")
    ) {
      if (progress.length === 0 || maxTotal.length === 0) {
        toast({ title: "Both timeout fields are required to change timeouts", error: true });
        return;
      }
      patch.timeout = { progressTimeout: progress, maxTotalTimeout: maxTotal };
    }

    try {
      await updateIdentity.mutateAsync({ workspaceId, patch });
      toast({ title: "Workspace identity saved" });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Save failed", description: err.message, error: true });
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
        <button
          type="button"
          class="section-nav-item"
          class:active={activeSection === section.id}
          onclick={() => {
            activeSection = section.id;
          }}
        >
          <span class="section-nav-label">{section.label}</span>
          <span class="section-nav-blurb">{section.blurb}</span>
        </button>
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
          <h2>Identity</h2>
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
        </div>

        <div class="actions">
          <Button
            variant="primary"
            onclick={saveIdentity}
            disabled={!identityDirty || updateIdentity.isPending}
          >
            {updateIdentity.isPending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onclick={resetIdentity} disabled={!identityDirty}>
            Discard
          </Button>
        </div>
      </section>
    {:else if activeSection === "agent-env"}
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
    {/if}
  </div>
</ListDetail>

<style>
  .section-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section-nav-item {
    background: none;
    border: none;
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--size-2) var(--size-2-5);
    text-align: start;
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
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .section-nav-blurb {
    color: color-mix(in srgb, var(--text), transparent 45%);
    font-size: var(--font-size-1);
  }

  .settings-detail {
    display: flex;
    flex-direction: column;
    padding: var(--size-8) var(--size-10);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    max-inline-size: 80ch;
  }

  .section > header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section h2 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-sub {
    color: color-mix(in srgb, var(--text), transparent 40%);
    font-size: var(--font-size-1);
    margin: 0;
    max-inline-size: 70ch;
  }

  .section-sub code,
  .field-hint code {
    font-size: var(--font-size-0, 11px);
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
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
  }

  .field-hint {
    color: color-mix(in srgb, var(--text), transparent 45%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .text-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-2);
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
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .agent-type {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--text), transparent 30%);
    font-size: var(--font-size-0, 11px);
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
    font-size: var(--font-size-1);
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
    font-size: var(--font-size-1);
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
    color: color-mix(in srgb, var(--text), transparent 45%);
    display: flex;
    flex: 1;
    gap: var(--size-2);
    font-size: var(--font-size-1);
  }

  .badge {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
  }

  .empty-state,
  .empty-hint {
    color: color-mix(in srgb, var(--text), transparent 45%);
    font-size: var(--font-size-1);
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
    font-size: var(--font-size-1);
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
    font-size: var(--font-size-0, 11px);
    padding: var(--size-0-5) var(--size-2);
  }
</style>
