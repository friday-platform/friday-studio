<!--
  MCP Server Detail — the content column for a selected catalog server.

  The middle-column section nav (`mcp-section-nav.svelte`) and the catalog
  breadcrumb live in the route's ListDetail sidebar; this component renders
  only the active section's content. Each section is its own route
  (`/mcp/{server}/{section}`).

  Install-time states (`setting_up`, `awaiting_confirm`) render a focused
  doctor view — there is nothing to navigate until the server is configured.

  @component
  @prop server - Installed server metadata (if selected)
  @prop section - Active section id from the route (null → overview)
  @prop onCheckUpdate / onPullUpdate / onDelete - Catalog actions
  @prop checking / pulling / deleting - Action-in-progress flags
  @prop hasUpdate - Whether an update is available
-->

<script lang="ts">
  import type {
    DoctorEnvVar,
    DoctorReport,
    MCPServerMetadata,
  } from "@atlas/core/mcp-registry/schemas";
  import { getAnnotation } from "@atlas/core/mcp-registry/annotations";
  import {
    Badge,
    Button,
    Dialog,
    IconSmall,
    MarkdownRendered,
    markdownToHTMLSafe,
    toast,
  } from "@atlas/ui";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { fade } from "svelte/transition";
  import { writable } from "svelte/store";
  import {
    type CommitEnvVar,
    type DoctorProgressEvent,
    doctorProgressStream,
    mcpQueries,
    useCancelMCPInstall,
    useCommitMCPInstall,
  } from "$lib/queries/mcp-queries";
  import ManualConfigSetup from "./manual-config-setup.svelte";
  import McpCredentialsPanel from "./mcp-credentials-panel.svelte";
  import { isOfficialServer, sourceLabel } from "./mcp-server-utils";
  import McpToolInvoker from "./mcp-tool-invoker.svelte";
  import McpToolsSection from "./mcp-tools-section.svelte";
  import McpWorkspaceUsage from "./mcp-workspace-usage.svelte";

  interface Props {
    server?: MCPServerMetadata | null;
    section?: string | null;
    onCheckUpdate?: () => void;
    onPullUpdate?: () => void;
    onDelete?: () => void;
    checking?: boolean;
    pulling?: boolean;
    deleting?: boolean;
    hasUpdate?: boolean;
  }

  let {
    server = null,
    section = null,
    onCheckUpdate,
    onPullUpdate,
    onDelete,
    checking = false,
    pulling = false,
    deleting = false,
    hasUpdate = false,
  }: Props = $props();

  const queryClient = useQueryClient();
  const deleteDialogOpen = writable(false);

  // Reset the delete dialog when navigating to a different server.
  $effect(() => {
    server?.id;
    deleteDialogOpen.set(false);
  });

  const activeSection = $derived(section ?? "overview");

  // ── Derived display values ─────────────────────────────────────────────
  const displayName = $derived(server?.name ?? "");
  const description = $derived(server?.description ?? null);
  const source = $derived(server?.source ?? null);
  const isInstalled = $derived(server !== null);
  const readme = $derived(server?.readme ?? null);
  const isOfficial = $derived(server ? isOfficialServer(server) : false);

  // Absent `status` means a legacy / static entry — treat it as `ready`.
  const status = $derived(server?.status ?? "ready");

  // Narrow the discriminated doctor_report union here, not inline in the
  // template — Svelte can't narrow a union across template boundaries.
  const report = $derived<DoctorReport | undefined>(server?.doctor_report);
  const reportAttention = $derived(report?.verdict === "attention" ? report : undefined);
  const reportUnknown = $derived(report?.verdict === "unknown" ? report : undefined);

  const curatorNotes = $derived(
    server?.upstream?.canonicalName
      ? (getAnnotation(server.upstream.canonicalName)?.staticNotes ?? null)
      : null,
  );

  // External links derived from the reverse-DNS canonical name.
  const githubUrl = $derived.by(() => {
    const canonical = server?.upstream?.canonicalName;
    const match = canonical?.match(/^io\.github\.([^/]+)\/(.+)$/);
    return match ? `https://github.com/${match[1]}/${match[2]}` : null;
  });
  const registryUrl = $derived.by(() => {
    const canonical = server?.upstream?.canonicalName;
    if (!canonical) return null;
    return `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(
      canonical,
    )}/versions/latest`;
  });

  const canCheckUpdate = $derived(isInstalled && server?.source === "registry" && !!onCheckUpdate);
  const canPullUpdate = $derived(
    isInstalled && server?.source === "registry" && hasUpdate && !!onPullUpdate,
  );
  const canDelete = $derived(isInstalled && server?.source !== "static" && !!onDelete);
  const hasActions = $derived(canCheckUpdate || canPullUpdate || canDelete);

  const transport = $derived.by((): { kind: string; value: string } => {
    const t = server?.configTemplate.transport;
    if (!t) return { kind: "unknown", value: "—" };
    if (t.type === "stdio") {
      return { kind: "stdio", value: `${t.command ?? "npx"} ${(t.args ?? []).join(" ")}`.trim() };
    }
    if (t.type === "http") {
      return { kind: "http", value: t.url ?? "HTTP endpoint" };
    }
    return { kind: "unknown", value: "—" };
  });

  // ── Environment variables, normalized into one table shape ─────────────
  interface EnvRow {
    key: string;
    tags: { label: string; tone: "required" | "secret" | "friday" | "neutral" }[];
    description: string;
  }

  function provenanceTag(envVar: DoctorEnvVar): EnvRow["tags"][number] | null {
    switch (envVar.provenance.source) {
      case "friday":
        return { label: "detected by Friday", tone: "friday" };
      case "registry":
        return { label: "from registry", tone: "neutral" };
      case "user":
        return { label: "added by you", tone: "neutral" };
    }
  }

  // The doctor's detected env vars are authoritative when present; otherwise
  // fall back to the registry-declared `requiredConfig`.
  const envRows = $derived.by((): EnvRow[] => {
    if (reportAttention) {
      return reportAttention.env_vars.map((v) => {
        const tags: EnvRow["tags"] = [];
        tags.push(
          v.isRequired
            ? { label: "required", tone: "required" }
            : { label: "optional", tone: "neutral" },
        );
        if (v.isSecret) tags.push({ label: "secret", tone: "secret" });
        const prov = provenanceTag(v);
        if (prov) tags.push(prov);
        return { key: v.name, tags, description: v.description ?? "" };
      });
    }
    const required = server?.requiredConfig ?? [];
    return required.map((field) => ({
      key: field.key,
      tags: [{ label: "required", tone: "required" as const }],
      description: field.description ?? "",
    }));
  });

  // ── `setting_up` — live doctor progress stream ─────────────────────────
  type DoctorPhase = Extract<DoctorProgressEvent, { type: "phase" }>["phase"];

  const PHASE_SEQUENCE: { phase: DoctorPhase; label: string }[] = [
    { phase: "fetching-readme", label: "Fetching README" },
    { phase: "prompting-llm", label: "Analyzing with the setup doctor" },
    { phase: "validating", label: "Validating findings" },
  ];

  let activePhase = $state<DoctorPhase | null>(null);
  let streamError = $state<string | null>(null);

  $effect(() => {
    const id = server?.id;
    if (!id || status !== "setting_up") return;

    let cancelled = false;
    activePhase = null;
    streamError = null;

    (async () => {
      try {
        for await (const event of doctorProgressStream(id)) {
          if (cancelled) return;
          if (event.type === "phase") {
            activePhase = event.phase;
          } else {
            await queryClient.invalidateQueries({ queryKey: mcpQueries.detail(id).queryKey });
            await queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
            return;
          }
        }
      } catch (e) {
        if (cancelled) return;
        streamError = e instanceof Error ? e.message : String(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  function phaseState(phase: DoctorPhase): "done" | "active" | "pending" {
    if (!activePhase) return "pending";
    const activeIndex = PHASE_SEQUENCE.findIndex((p) => p.phase === activePhase);
    const thisIndex = PHASE_SEQUENCE.findIndex((p) => p.phase === phase);
    if (thisIndex < activeIndex) return "done";
    if (thisIndex === activeIndex) return "active";
    return "pending";
  }

  // ── Install flow mutations — cancel + commit ───────────────────────────
  const cancelMut = useCancelMCPInstall();
  const commitMut = useCommitMCPInstall();

  async function handleCancelInstall(): Promise<void> {
    const id = server?.id;
    if (!id || cancelMut.isPending) return;
    try {
      await cancelMut.mutateAsync(id);
      toast({ title: "Install cancelled", description: `${displayName} has been discarded.` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Cancel failed", description: message, error: true });
    }
  }

  async function handleConfirmInstall(): Promise<void> {
    const id = server?.id;
    if (!id || commitMut.isPending || !reportAttention) return;
    const envVars: CommitEnvVar[] = reportAttention.env_vars.map((v) => ({
      name: v.name,
      description: v.description,
      isRequired: v.isRequired,
      isSecret: v.isSecret,
      default: v.default,
    }));
    try {
      await commitMut.mutateAsync({ id, envVars });
      toast({ title: "Server configured", description: `${displayName} is ready to use.` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Confirm failed", description: message, error: true });
    }
  }

  // ── Inline panel toggles ───────────────────────────────────────────────
  let manualConfigOpenFor = $state<string | null>(null);
  const manualConfigOpen = $derived(!!server && manualConfigOpenFor === server.id);
  function toggleManualConfig(): void {
    manualConfigOpenFor = manualConfigOpen ? null : (server?.id ?? null);
  }

  let rawConfigOpenFor = $state<string | null>(null);
  const rawConfigOpen = $derived(!!server && rawConfigOpenFor === server.id);
  function toggleRawConfig(): void {
    rawConfigOpenFor = rawConfigOpen ? null : (server?.id ?? null);
  }
  const rawConfigJson = $derived(server ? JSON.stringify(server.configTemplate, null, 2) : "");
</script>

{#snippet sourceBadges()}
  {#if source}
    <Badge variant="status">
      {sourceLabel(source)}{#if isOfficial}&nbsp;• Official{/if}
    </Badge>
  {/if}
  {#if status === "setting_up"}
    <Badge variant="info">Installing</Badge>
  {:else if status === "awaiting_confirm"}
    <Badge variant="warning">Awaiting setup</Badge>
  {:else if reportUnknown}
    <Badge variant="warning">Needs configuration</Badge>
  {/if}
{/snippet}

{#snippet envTable(rows: EnvRow[])}
  <table class="env-table">
    <thead>
      <tr><th>Key</th><th>Tags</th><th>Description</th></tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr>
          <td><code class="env-key">{row.key}</code></td>
          <td>
            <div class="tag-cell">
              {#each row.tags as tag (tag.label)}
                <span class="tag" data-tone={tag.tone}>{tag.label}</span>
              {/each}
            </div>
          </td>
          <td class="env-desc">{row.description || "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet deleteDialog()}
  <Dialog.Root open={deleteDialogOpen}>
    <Dialog.Content>
      <Dialog.Close />
      {#snippet header()}
        <Dialog.Title>Remove server</Dialog.Title>
        <Dialog.Description>
          {displayName} will be uninstalled and no longer available to your agents. You can
          reinstall it from the registry at any time.
        </Dialog.Description>
      {/snippet}
      {#snippet footer()}
        <Dialog.Button onclick={onDelete} disabled={deleting} closeOnClick={false}>
          {deleting ? "Removing…" : "Remove"}
        </Dialog.Button>
        <Dialog.Cancel onclick={() => deleteDialogOpen.set(false)}>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  </Dialog.Root>
{/snippet}

{#if !server}
  <div class="loading-state">
    <p>Loading server…</p>
  </div>
{:else if status === "setting_up" || status === "awaiting_confirm"}
  <!-- ── Focused install view — no section nav ──────────────────────────── -->
  <div class="install-view">
    <header class="install-header">
      <div class="title-row">
        <h1>{displayName}</h1>
        {@render sourceBadges()}
      </div>
      <p class="description" class:faded={!description}>
        {description ?? "No description provided"}
      </p>
    </header>

    {#if status === "setting_up"}
      <section class="panel">
        <h2 class="section-title">Setup doctor running</h2>
        <p class="section-desc">
          Friday is analyzing this server to work out what configuration it needs. This usually
          takes a few seconds.
        </p>
        <ol class="phase-list">
          {#each PHASE_SEQUENCE as { phase, label } (phase)}
            {@const state = phaseState(phase)}
            <li class="phase-item" data-state={state}>
              <span class="phase-icon">
                {#if state === "done"}
                  <IconSmall.CheckCircle />
                {:else if state === "active"}
                  <IconSmall.Progress />
                {:else}
                  <IconSmall.Clock />
                {/if}
              </span>
              <span>{label}</span>
            </li>
          {/each}
        </ol>
        {#if streamError}
          <p class="stream-error">
            Lost the progress stream ({streamError}). Reload to reconnect — the server keeps
            working in the background.
          </p>
        {/if}
        <div class="actions-row">
          <Button
            variant="secondary"
            size="small"
            onclick={handleCancelInstall}
            disabled={cancelMut.isPending}
          >
            {cancelMut.isPending ? "Cancelling…" : "Cancel install"}
          </Button>
        </div>
      </section>
    {:else if reportAttention}
      <section class="panel">
        <h2 class="section-title">Review detected configuration</h2>
        <p class="section-desc">{reportAttention.tldr}</p>
        <p class="section-desc">
          The setup doctor found the environment variables below. Confirm to finish install.
        </p>
        {@render envTable(envRows)}
        <div class="actions-row">
          <Button
            variant="primary"
            size="small"
            onclick={handleConfirmInstall}
            disabled={commitMut.isPending}
          >
            {commitMut.isPending ? "Applying…" : "Confirm & apply"}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onclick={handleCancelInstall}
            disabled={cancelMut.isPending}
          >
            {cancelMut.isPending ? "Cancelling…" : "Cancel install"}
          </Button>
        </div>
      </section>
    {/if}
  </div>
{:else}
  <!-- ── Ready: ListDetail with section nav ─────────────────────────────── -->
  <div class="detail-root">
    {#if hasActions}
      <div class="actions-bar">
        <span class="actions-indent actions-indent-tl" aria-hidden="true"></span>
        <div class="actions-int">
          {#if canCheckUpdate}
            <Button
              size="small"
              variant="none"
              onclick={onCheckUpdate}
              disabled={checking || pulling}
            >
              {#snippet prepend()}<IconSmall.ArrowsRotate />{/snippet}
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          {/if}
          {#if canPullUpdate}
            <Button size="small" variant="primary" onclick={onPullUpdate} disabled={pulling}>
              {pulling ? "Updating…" : "Pull update"}
            </Button>
          {/if}
          {#if canDelete}
            <Button
              size="small"
              variant="none"
              onclick={() => deleteDialogOpen.set(true)}
              disabled={deleting}
            >
              {#snippet prepend()}<IconSmall.TrashBin />{/snippet}
              {deleting ? "Removing…" : "Remove"}
            </Button>
          {/if}
        </div>
        <span class="actions-indent actions-indent-br" aria-hidden="true"></span>
      </div>
    {/if}

    <div class="section-content">
        {#key activeSection}
          <div class="section-inner" in:fade={{ duration: 120 }}>
            {#if activeSection === "overview"}
              <section class="section">
                <div class="overview-header">
                  <h2 class="section-title">{displayName}</h2>
                  <div class="badge-row">{@render sourceBadges()}</div>
                </div>
                <p class="description" class:faded={!description}>
                  {description ?? "No description provided"}
                </p>
                <div class="header-links">
                  {#if githubUrl}
                    <a
                      class="ext-link"
                      href={githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <IconSmall.ExternalLink />
                      GitHub
                    </a>
                  {/if}
                  {#if registryUrl}
                    <a
                      class="ext-link"
                      href={registryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <IconSmall.ExternalLink />
                      Registry record
                    </a>
                  {/if}
                </div>
                <div class="transport-row">
                  <span class="tag" data-tone="neutral">{transport.kind}</span>
                  <code class="transport-value">{transport.value}</code>
                </div>
              </section>

              <section class="section">
                <h2 class="section-title">How Friday manages this MCP</h2>
                <p class="section-desc">
                  On install, Friday's setup doctor reads the server's README and package
                  metadata to work out what it needs. Credential-bearing variables are routed to
                  connected integrations; plain settings are stored per-workspace. Anything the
                  doctor can't place is left for you to configure manually.
                </p>

                {#if report}
                  <div class="notice-box" data-verdict={report.verdict}>
                    <span class="notice-icon">
                      {#if report.verdict === "clean"}
                        <IconSmall.CheckCircle />
                      {:else if report.verdict === "attention"}
                        <IconSmall.InfoCircle />
                      {:else}
                        <IconSmall.TriangleExclamation />
                      {/if}
                    </span>
                    <div class="notice-body">
                      <span class="notice-title">{report.tldr}</span>
                      {#if report.verdict === "clean"}
                        <span class="notice-detail">
                          Self-contained — no extra configuration needed.
                        </span>
                      {:else if report.verdict === "attention"}
                        <span class="notice-detail">
                          Detected configuration is listed under Config Reference.
                        </span>
                      {/if}
                    </div>
                  </div>

                  {#each report.findings as finding, i (i)}
                    <div class="notice-box" data-severity={finding.severity}>
                      <span class="notice-icon">
                        {#if finding.severity === "error"}
                          <IconSmall.TriangleExclamation />
                        {:else if finding.severity === "warn"}
                          <IconSmall.InfoCircle />
                        {:else}
                          <IconSmall.InfoCircle />
                        {/if}
                      </span>
                      <div class="notice-body">
                        <span class="notice-title">{finding.title}</span>
                        {#if finding.detail}
                          <span class="notice-detail">{finding.detail}</span>
                        {/if}
                      </div>
                    </div>
                  {/each}

                  {#if reportUnknown}
                    <div class="actions-row">
                      <Button variant="primary" size="small" onclick={toggleManualConfig}>
                        {manualConfigOpen ? "Hide manual setup" : "Configure manually"}
                      </Button>
                      {#if githubUrl}
                        <Button
                          variant="secondary"
                          size="small"
                          href={githubUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {#snippet prepend()}<IconSmall.ExternalLink />{/snippet}
                          Contact author
                        </Button>
                      {/if}
                    </div>
                    {#if manualConfigOpen}
                      <ManualConfigSetup
                        serverId={server.id}
                        onDone={() => (manualConfigOpenFor = null)}
                      />
                    {/if}
                  {/if}
                {/if}
              </section>
            {:else if activeSection === "connections"}
              <section class="section">
                <h2 class="section-title">Connections</h2>
                <p class="section-desc">
                  The integration credentials this server connects through, and the workspaces
                  that have it enabled.
                </p>
                <div class="sub-block">
                  <h3 class="sub-title">Credentials</h3>
                  <p class="sub-desc">
                    Server-process credentials, managed through Link. If a credential isn't
                    connected yet, use the connect card to link one.
                  </p>
                  <McpCredentialsPanel
                    serverId={server.id}
                    configTemplate={server.configTemplate}
                  />
                </div>
                <div class="sub-block">
                  <h3 class="sub-title">Enabled in these workspaces</h3>
                  <p class="sub-desc">
                    Workspaces that currently have this server turned on, and the agents and jobs
                    using it.
                  </p>
                  <McpWorkspaceUsage serverId={server.id} />
                </div>
              </section>
            {:else if activeSection === "configuration"}
              <section class="section">
                <h2 class="section-title">Config Reference</h2>
                <p class="section-desc">
                  Reference only — these are the environment variables this server reads. The
                  actual values are set per workspace, in that workspace's settings.
                </p>

                {#if envRows.length > 0}
                  <div class="sub-block">
                    <h3 class="sub-title">Environment variables</h3>
                    <p class="sub-desc">
                      Each variable, whether it's required or secret, and where Friday detected
                      it. Tags carry through to the per-workspace settings UI.
                    </p>
                    {@render envTable(envRows)}
                  </div>
                {:else}
                  <p class="empty-line">This server declares no environment variables.</p>
                {/if}

                <div class="sub-block">
                  <h3 class="sub-title">Raw config</h3>
                  <p class="sub-desc">
                    The exact server config snapshotted into each workspace on enable.
                  </p>
                  <button type="button" class="raw-toggle" onclick={toggleRawConfig}>
                    {#if rawConfigOpen}
                      <IconSmall.ChevronDown />
                    {:else}
                      <IconSmall.ChevronRight />
                    {/if}
                    {rawConfigOpen ? "Hide raw config" : "View raw config"}
                  </button>
                  {#if rawConfigOpen}
                    <pre class="raw-block">{rawConfigJson}</pre>
                  {/if}
                </div>
              </section>
            {:else if activeSection === "tools"}
              <section class="section">
                <h2 class="section-title">Testing</h2>
                <p class="section-desc">
                  Connect to this server and exercise it directly — browse the tools it exposes,
                  then invoke one against an optional workspace context to see the real output.
                  Loading either list opens a connection to the server.
                </p>
                <div class="sub-block">
                  <h3 class="sub-title">Available tools</h3>
                  <p class="sub-desc">The tools this server exposes, with their input schemas.</p>
                  <McpToolsSection serverId={server.id} />
                </div>
                <div class="sub-block">
                  <h3 class="sub-title">Invoke a tool</h3>
                  <p class="sub-desc">
                    Pick a tool, fill its inputs, and run it. The workspace selector scopes the
                    call to that workspace's configured credentials and settings.
                  </p>
                  <McpToolInvoker serverId={server.id} />
                </div>
              </section>
            {:else if activeSection === "readme"}
              {#if curatorNotes}
                <section class="section">
                  <h2 class="section-title">From the curators</h2>
                  <div class="readme">
                    <MarkdownRendered>{@html markdownToHTMLSafe(curatorNotes)}</MarkdownRendered>
                  </div>
                </section>
              {/if}
              <section class="section">
                <h2 class="section-title">Readme</h2>
                {#if readme}
                  <div class="readme">
                    <MarkdownRendered>{@html markdownToHTMLSafe(readme)}</MarkdownRendered>
                  </div>
                {:else}
                  <p class="section-desc">This server has no README.</p>
                {/if}
              </section>
            {/if}
          </div>
        {/key}
      </div>
  </div>
{/if}

{@render deleteDialog()}

<style>
  /* ── Roots ───────────────────────────────────────────────────────────── */

  /* Content column of the route's ListDetail. `position: relative` anchors
     the floating actions bar; the ListDetail content pane owns the scroll. */
  .detail-root {
    position: relative;
  }

  .install-view {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    margin: 0 auto;
    max-inline-size: 96ch;
    padding: var(--size-6) var(--size-10) var(--size-12);
    inline-size: 100%;
  }

  .loading-state {
    align-items: center;
    color: var(--text-faded);
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
  }

  /* ── Section content ─────────────────────────────────────────────────── */

  .section-content {
    inline-size: 100%;
  }

  .section-inner {
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    margin: 0 auto;
    max-inline-size: 96ch;
    padding: var(--size-8) var(--size-10) var(--size-12);
    inline-size: 100%;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .panel {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-4);
  }

  .section-title {
    color: var(--text-bright);
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    line-height: 1.55;
    margin: 0;
    max-inline-size: 76ch;
  }

  .install-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .title-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .title-row h1 {
    color: var(--text-bright);
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    margin: 0;
    word-break: break-word;
  }

  .description {
    color: var(--text);
    font-size: var(--font-size-4);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 72ch;
  }

  .description.faded {
    color: var(--text);
  }

  .header-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .ext-link {
    align-items: center;
    color: var(--blue-primary);
    display: inline-flex;
    font-size: var(--font-size-3);
    gap: var(--size-1);
    text-decoration: none;
  }

  .ext-link:hover {
    text-decoration: underline;
  }

  .sub-block {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .sub-title {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .actions-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  /* ── Floating top-right actions ──────────────────────────────────────── */

  .actions-bar {
    align-items: center;
    display: flex;
    inset-block-start: 0;
    inset-inline-end: 0;
    position: absolute;
    z-index: 2;
  }

  .actions-int {
    background-color: var(--surface-dark);
    block-size: var(--size-8);
    border-end-start-radius: var(--radius-6);
    border-start-end-radius: var(--radius-6);
    display: flex;
    gap: var(--size-4);
    padding-inline: var(--size-4);
  }

  .actions-indent {
    background-color: var(--surface-dark);
    position: absolute;
  }

  .actions-indent-tl {
    block-size: 11px;
    clip-path: path("M11 11C11 4.92487 6.07513 0 0 0H11V11Z");
    inline-size: 11px;
    inset-block-start: 0;
    inset-inline-end: 100%;
  }

  .actions-indent-br {
    block-size: 12px;
    clip-path: path("M12 12C12 5.37258 6.62742 0 0 0H12V12Z");
    inline-size: 12px;
    inset-block-start: 100%;
    inset-inline-end: 0;
  }

  /* ── Notice box — one box style for every notice (verdict + findings) ── */

  .notice-box {
    align-items: flex-start;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .notice-box[data-verdict="unknown"],
  .notice-box[data-severity="error"] {
    border-color: color-mix(in srgb, var(--red-primary), var(--border) 55%);
  }

  .notice-box[data-severity="warn"] {
    border-color: color-mix(in srgb, var(--yellow-primary), var(--border) 55%);
  }

  .notice-icon {
    align-items: center;
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    margin-block-start: 1px;
  }

  .notice-box[data-verdict="clean"] .notice-icon {
    color: var(--green-primary);
  }

  .notice-box[data-verdict="attention"] .notice-icon {
    color: var(--blue-primary);
  }

  .notice-box[data-verdict="unknown"] .notice-icon,
  .notice-box[data-severity="error"] .notice-icon {
    color: var(--red-primary);
  }

  .notice-box[data-severity="warn"] .notice-icon {
    color: var(--yellow-primary);
  }

  .notice-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .notice-title {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .notice-detail {
    color: var(--text);
    font-size: var(--font-size-3);
    line-height: 1.5;
  }

  /* ── Overview header + badges ────────────────────────────────────────── */

  .overview-header {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2) var(--size-3);
  }

  .overview-header .section-title {
    word-break: break-word;
  }

  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .sub-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 76ch;
  }

  .empty-line {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
  }

  /* ── Env table ───────────────────────────────────────────────────────── */

  .env-table {
    border: 1px solid var(--border);
    border-collapse: collapse;
    font-size: var(--font-size-3);
    inline-size: 100%;
  }

  .env-table th {
    background-color: var(--surface);
    border-block-end: 1px solid var(--border);
    color: var(--text);
    font-weight: var(--font-weight-6);
    padding: var(--size-1-5) var(--size-2);
    text-align: start;
  }

  .env-table td {
    border-block-end: 1px solid color-mix(in srgb, var(--border), transparent 45%);
    padding: var(--size-1-5) var(--size-2);
    vertical-align: top;
  }

  .env-table tr:last-child td {
    border-block-end: none;
  }

  .env-key {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    white-space: nowrap;
  }

  .env-desc {
    color: var(--text);
  }

  .tag-cell {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .tag {
    background-color: var(--highlight);
    border-radius: var(--radius-1);
    color: var(--text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
    white-space: nowrap;
  }

  .tag[data-tone="required"] {
    background-color: color-mix(in srgb, var(--yellow-primary), transparent 85%);
    color: color-mix(in srgb, var(--yellow-primary), var(--text-bright) 35%);
  }

  .tag[data-tone="secret"] {
    background-color: color-mix(in srgb, var(--purple-primary), transparent 85%);
    color: color-mix(in srgb, var(--purple-primary), var(--text-bright) 35%);
  }

  .tag[data-tone="friday"] {
    background-color: color-mix(in srgb, var(--blue-primary), transparent 85%);
    color: color-mix(in srgb, var(--blue-primary), var(--text-bright) 35%);
  }

  /* ── Transport ───────────────────────────────────────────────────────── */

  .transport-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .transport-value {
    color: var(--text);
    font-size: var(--font-size-3);
    word-break: break-all;
  }

  /* ── Raw config ──────────────────────────────────────────────────────── */

  .raw-toggle {
    align-items: center;
    background: none;
    border: none;
    color: var(--text);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-3);
    gap: var(--size-1);
    padding: 0;
  }

  .raw-toggle:hover {
    color: var(--text-bright);
  }

  .raw-block {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    margin: 0;
    overflow-x: auto;
    padding: var(--size-3);
  }

  /* ── Phase list (setting_up) ─────────────────────────────────────────── */

  .phase-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .phase-item {
    align-items: center;
    color: var(--text-faded);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-2);
  }

  .phase-item[data-state="active"] {
    color: var(--text-bright);
    font-weight: var(--font-weight-6);
  }

  .phase-item[data-state="done"] {
    color: var(--green-primary);
  }

  .phase-icon {
    align-items: center;
    display: flex;
    flex-shrink: 0;
  }

  .stream-error {
    color: var(--yellow-primary);
    font-size: var(--font-size-2);
    margin: 0;
  }

  /* ── Readme ──────────────────────────────────────────────────────────── */

  .readme {
    font-size: var(--font-size-3);
  }
</style>
