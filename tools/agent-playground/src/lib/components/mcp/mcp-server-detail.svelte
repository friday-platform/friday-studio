<!--
  MCP Server Detail — right pane for the two-pane catalog layout.

  This is the entire UI surface for the setup doctor. What it renders is driven
  by `server.status` + `server.doctor_report.verdict`:

  - `setting_up`      — a live "Setup doctor running" view consuming the
                        doctor's SSE progress stream.
  - `awaiting_confirm`— a review checkpoint over the doctor's detected env vars.
  - `ready` + verdict — the normal detail view, plus a verdict-appropriate
                        treatment (findings banner / provenance tags / a clean
                        note) and a TL;DR strip.
  - `ready`, no report (legacy / static servers) — the normal detail view.

  @component
  @prop server - Installed server metadata (if selected)
  @prop onCheckUpdate - Called to check for updates
  @prop onPullUpdate - Called to pull an update
  @prop onDelete - Called to remove a server
  @prop checking - Whether check-update is in progress
  @prop pulling - Whether pull-update is in progress
  @prop deleting - Whether delete is in progress
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
    SimpleTable,
    toast,
  } from "@atlas/ui";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { writable } from "svelte/store";
  import {
    type CommitEnvVar,
    type DoctorProgressEvent,
    doctorProgressStream,
    mcpQueries,
    useCancelMCPInstall,
    useCommitMCPInstall,
  } from "$lib/queries/mcp-queries";
  import McpConnectionTest from "./mcp-connection-test.svelte";
  import McpCredentialsPanel from "./mcp-credentials-panel.svelte";
  import ManualConfigSetup from "./manual-config-setup.svelte";
  import { isOfficialServer, sourceLabel } from "./mcp-server-utils";
  import McpTestChat from "./mcp-test-chat.svelte";
  import McpWorkspaceUsage from "./mcp-workspace-usage.svelte";

  interface Props {
    server?: MCPServerMetadata | null;
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

  // Reset delete dialog when navigating to a different server
  $effect(() => {
    server?.id;
    deleteDialogOpen.set(false);
  });

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const displayName = $derived(server?.name ?? "");
  const description = $derived(server?.description ?? null);
  const source = $derived(server?.source ?? null);
  const isInstalled = $derived(server !== null);
  const readme = $derived(server?.readme ?? null);

  const isOfficial = $derived(server ? isOfficialServer(server) : false);

  // Absent `status` means a legacy / static entry — treat it as `ready`.
  const status = $derived(server?.status ?? "ready");

  // Narrow the discriminated doctor_report union here, in <script>, not inline
  // in the template — Svelte can't narrow a union across template boundaries.
  const report = $derived<DoctorReport | undefined>(server?.doctor_report);
  const reportClean = $derived(
    report?.verdict === "clean" ? report : undefined,
  );
  const reportAttention = $derived(
    report?.verdict === "attention" ? report : undefined,
  );
  const reportUnknown = $derived(
    report?.verdict === "unknown" ? report : undefined,
  );

  // Whether the normal detail view (transport, credentials, chat, etc.) shows.
  const showNormalView = $derived(status === "ready");

  // Curator-authored markdown for this canonical name, rendered above README.
  const curatorNotes = $derived(
    server?.upstream?.canonicalName
      ? (getAnnotation(server.upstream.canonicalName)?.staticNotes ?? null)
      : null,
  );

  // Best-effort upstream repo URL for the "Contact author" link. Registry
  // canonical names are reverse-DNS; `io.github.OWNER/REPO` maps cleanly to a
  // GitHub URL. Anything else we can't resolve without persisting the repo URL.
  const contactAuthorUrl = $derived.by(() => {
    const canonical = server?.upstream?.canonicalName;
    if (!canonical) return null;
    const match = canonical.match(/^io\.github\.([^/]+)\/(.+)$/);
    if (!match) return null;
    return `https://github.com/${match[1]}/${match[2]}`;
  });

  const canCheckUpdate = $derived(
    isInstalled && server?.source === "registry" && !!onCheckUpdate,
  );
  const canPullUpdate = $derived(
    isInstalled && server?.source === "registry" && hasUpdate && !!onPullUpdate,
  );
  const canDelete = $derived(
    isInstalled && server?.source !== "static" && !!onDelete,
  );
  const hasActions = $derived(canCheckUpdate || canPullUpdate || canDelete);

  function transportInfo(s: MCPServerMetadata): string {
    const t = s.configTemplate.transport;
    if (!t) return "unknown";
    if (t.type === "stdio") {
      return `${t.command ?? "npx"} ${(t.args ?? []).join(" ")}`;
    }
    if (t.type === "http") {
      return t.url ?? "HTTP endpoint";
    }
    return "unknown";
  }

  function formatDate(iso: string | undefined): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  // ---------------------------------------------------------------------------
  // `setting_up` — live doctor progress stream
  // ---------------------------------------------------------------------------

  type DoctorPhase = Extract<DoctorProgressEvent, { type: "phase" }>["phase"];

  const PHASE_SEQUENCE: { phase: DoctorPhase; label: string }[] = [
    { phase: "fetching-readme", label: "Fetching README" },
    { phase: "prompting-llm", label: "Analyzing with the setup doctor" },
    { phase: "validating", label: "Validating findings" },
  ];

  let activePhase = $state<DoctorPhase | null>(null);
  let streamError = $state<string | null>(null);

  // Consume the doctor's SSE stream while `setting_up`. On the terminal
  // `result` event, re-fetch the detail query so the page transitions to its
  // terminal state. The effect re-runs (and cancels the prior stream) whenever
  // the server id or status changes.
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
            // Terminal `result` — the entry's persisted status is the source
            // of truth, so re-fetch it to pick up the transition.
            await queryClient.invalidateQueries({
              queryKey: mcpQueries.detail(id).queryKey,
            });
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

  // ---------------------------------------------------------------------------
  // Install flow mutations — cancel + commit
  // ---------------------------------------------------------------------------

  const cancelMut = useCancelMCPInstall();
  const commitMut = useCommitMCPInstall();

  async function handleCancelInstall(): Promise<void> {
    const id = server?.id;
    if (!id || cancelMut.isPending) return;
    try {
      await cancelMut.mutateAsync(id);
      toast({
        title: "Install cancelled",
        description: `${displayName} has been discarded.`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Cancel failed", description: message, error: true });
    }
  }

  async function handleConfirmInstall(): Promise<void> {
    const id = server?.id;
    if (!id || commitMut.isPending || !reportAttention) return;
    // Map the reviewed list to CommitEnvVar[] — provenance is review-only and
    // dropped before commit.
    const envVars: CommitEnvVar[] = reportAttention.env_vars.map((v) => ({
      name: v.name,
      description: v.description,
      isRequired: v.isRequired,
      isSecret: v.isSecret,
      default: v.default,
    }));
    try {
      await commitMut.mutateAsync({ id, envVars });
      toast({
        title: "Server configured",
        description: `${displayName} is ready to use.`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Confirm failed", description: message, error: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Inline panel toggles — manual-config and the read-only raw-config view.
  //
  // Each toggle stores the server id it was opened for, so a `$derived` can ask
  // "open for the *current* server?" — switching servers collapses the panel
  // with no reset `$effect` needed.
  // ---------------------------------------------------------------------------

  let manualConfigOpenFor = $state<string | null>(null);
  const manualConfigOpen = $derived(
    !!server && manualConfigOpenFor === server.id,
  );

  function toggleManualConfig(): void {
    manualConfigOpenFor = manualConfigOpen ? null : (server?.id ?? null);
  }

  let rawConfigOpenFor = $state<string | null>(null);
  const rawConfigOpen = $derived(!!server && rawConfigOpenFor === server.id);

  function toggleRawConfig(): void {
    rawConfigOpenFor = rawConfigOpen ? null : (server?.id ?? null);
  }

  const rawConfigJson = $derived(
    server ? JSON.stringify(server.configTemplate, null, 2) : "",
  );

  // ---------------------------------------------------------------------------
  // Provenance label for a committed / detected env var
  // ---------------------------------------------------------------------------

  function provenanceLabel(envVar: DoctorEnvVar): string {
    switch (envVar.provenance.source) {
      case "registry":
        return "registry";
      case "friday":
        return "detected by Friday";
      case "user":
        return "added by you";
    }
  }
</script>

<div class="detail-pane">
  {#if !server}
    <!-- Empty state -->
    <div class="empty-state">
      <div class="empty-icon">
        <IconSmall.Search />
      </div>
      <h2 class="empty-title">MCP Catalog</h2>
      <p class="empty-desc">
        Select a server from the list to view details, or search the upstream
        registry to discover new servers.
      </p>
    </div>
  {:else}
    <article>
      {#if hasActions}
        <div class="actions-bar">
          <span class="actions-indent actions-indent-tl" aria-hidden="true"
          ></span>
          <div class="actions-int">
            {#if canCheckUpdate}
              <Button
                size="small"
                variant="none"
                onclick={onCheckUpdate}
                disabled={checking || pulling}
              >
                {#snippet prepend()}
                  <IconSmall.ArrowsRotate />
                {/snippet}
                {checking ? "Checking…" : "Check for updates"}
              </Button>
            {/if}

            {#if canPullUpdate}
              <Button
                size="small"
                variant="primary"
                onclick={onPullUpdate}
                disabled={pulling}
              >
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
                {#snippet prepend()}
                  <IconSmall.TrashBin />
                {/snippet}
                {deleting ? "Removing…" : "Remove"}
              </Button>
            {/if}

            <Dialog.Root open={deleteDialogOpen}>
              <Dialog.Content>
                <Dialog.Close />
                {#snippet header()}
                  <Dialog.Title>Remove server</Dialog.Title>
                  <Dialog.Description>
                    {displayName} will be uninstalled and no longer available to your
                    agents. You can reinstall it from the registry at any time.
                  </Dialog.Description>
                {/snippet}
                {#snippet footer()}
                  <Dialog.Button
                    onclick={onDelete}
                    disabled={deleting}
                    closeOnClick={false}
                  >
                    {deleting ? "Removing…" : "Remove"}
                  </Dialog.Button>
                  <Dialog.Cancel onclick={() => deleteDialogOpen.set(false)}
                    >Cancel</Dialog.Cancel
                  >
                {/snippet}
              </Dialog.Content>
            </Dialog.Root>
          </div>
          <span class="actions-indent actions-indent-br" aria-hidden="true"
          ></span>
        </div>
      {/if}

      <header>
        <h1>{displayName}</h1>

        <div class="header-badges">
          {#if source}
            <Badge variant="status">
              {sourceLabel(source)}

              {#if isOfficial}
                • Official
              {/if}
            </Badge>
          {/if}
          {#if status === "setting_up"}
            <Badge variant="info">Installing</Badge>
          {:else if status === "awaiting_confirm"}
            <Badge variant="warning">Awaiting setup</Badge>
          {:else if reportUnknown}
            <Badge variant="warning">Needs configuration</Badge>
          {/if}
        </div>
      </header>

      <!-- TL;DR strip — shown whenever the doctor produced a report. -->
      {#if report}
        <p class="tldr-strip">{report.tldr}</p>
      {/if}

      <!-- Content -->
      <div class="detail-content">
        <p class="description" class:faded={!description}>
          {description ?? "No description provided"}
        </p>

        <!-- ── setting_up: live doctor progress ─────────────────────────── -->
        {#if status === "setting_up"}
          <div class="doctor-panel">
            <h3 class="section-title">Setup doctor running</h3>
            <p class="doctor-panel-desc">
              Friday is analyzing this server to work out what configuration it
              needs. This usually takes a few seconds.
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
                  <span class="phase-label">{label}</span>
                </li>
              {/each}
            </ol>
            {#if streamError}
              <p class="doctor-stream-error">
                Lost the progress stream ({streamError}). Reload the page to
                reconnect — the server keeps working in the background.
              </p>
            {/if}
            <div class="doctor-actions">
              <Button
                variant="secondary"
                size="small"
                onclick={handleCancelInstall}
                disabled={cancelMut.isPending}
              >
                {cancelMut.isPending ? "Cancelling…" : "Cancel install"}
              </Button>
            </div>
          </div>
        {/if}

        <!-- ── awaiting_confirm: review checkpoint ──────────────────────── -->
        {#if status === "awaiting_confirm" && reportAttention}
          <div class="doctor-panel">
            <h3 class="section-title">Review detected configuration</h3>
            <p class="doctor-panel-desc">
              The setup doctor found the environment variables below. Check each
              one against where it came from, then confirm to finish install.
            </p>

            <ul class="env-review-list">
              {#each reportAttention.env_vars as envVar (envVar.name)}
                <li class="env-review-item">
                  <div class="env-review-head">
                    <span class="env-name">{envVar.name}</span>
                    <div class="env-flags">
                      {#if envVar.isRequired}
                        <span class="env-flag env-flag-required">Required</span>
                      {:else}
                        <span class="env-flag">Optional</span>
                      {/if}
                      {#if envVar.isSecret}
                        <span class="env-flag env-flag-secret">Secret</span>
                      {/if}
                      <span class="env-flag env-flag-provenance">
                        {provenanceLabel(envVar)}
                      </span>
                    </div>
                  </div>
                  {#if envVar.description}
                    <p class="env-description">{envVar.description}</p>
                  {/if}
                  {#if envVar.provenance.source === "friday"}
                    <blockquote class="env-excerpt">
                      {envVar.provenance.readme_excerpt}
                    </blockquote>
                  {/if}
                </li>
              {/each}
            </ul>

            <div class="doctor-actions">
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
          </div>
        {/if}

        <!-- ── ready + unknown: findings banner + manual config ─────────── -->
        {#if reportUnknown}
          <div class="doctor-panel doctor-panel-warning">
            <h3 class="section-title">This server needs configuration</h3>
            <p class="doctor-panel-desc">
              The setup doctor couldn't work out exactly what this server needs.
              Here's what it saw — you can configure it manually below, or reach
              out to the upstream author.
            </p>

            <ul class="findings-list">
              {#each reportUnknown.findings as finding, i (i)}
                <li class="finding-item" data-severity={finding.severity}>
                  <span class="finding-title">{finding.title}</span>
                  {#if finding.detail}
                    <span class="finding-detail">{finding.detail}</span>
                  {/if}
                </li>
              {/each}
            </ul>

            <div class="doctor-actions">
              <Button variant="primary" size="small" onclick={toggleManualConfig}>
                {manualConfigOpen ? "Hide manual setup" : "Configure manually"}
              </Button>
              {#if contactAuthorUrl}
                <Button
                  variant="secondary"
                  size="small"
                  href={contactAuthorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {#snippet prepend()}
                    <IconSmall.ExternalLink />
                  {/snippet}
                  Contact author
                </Button>
              {/if}
            </div>

            {#if manualConfigOpen && server}
              <ManualConfigSetup
                serverId={server.id}
                onDone={() => (manualConfigOpenFor = null)}
              />
            {/if}
          </div>
        {/if}

        <!-- ── ready + attention: committed env vars with provenance ────── -->
        {#if showNormalView && reportAttention}
          <div class="content-section">
            <h3 class="section-title">Configured environment variables</h3>
            <ul class="env-summary-list">
              {#each reportAttention.env_vars as envVar (envVar.name)}
                <li class="env-summary-item">
                  <span class="env-name">{envVar.name}</span>
                  <div class="env-flags">
                    {#if envVar.isRequired}
                      <span class="env-flag env-flag-required">Required</span>
                    {/if}
                    {#if envVar.isSecret}
                      <span class="env-flag env-flag-secret">Secret</span>
                    {/if}
                    <span class="env-flag env-flag-provenance">
                      {provenanceLabel(envVar)}
                    </span>
                  </div>
                  {#if envVar.description}
                    <p class="env-description">{envVar.description}</p>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- ── ready + clean: subtle self-contained note ────────────────── -->
        {#if showNormalView && reportClean}
          <p class="clean-note">
            <IconSmall.Check />
            Setup doctor: self-contained — no extra configuration needed.
          </p>
        {/if}

        {#if isInstalled && server && showNormalView}
          <div>
            <McpConnectionTest serverId={server.id} />
          </div>
          <!-- Transport -->
          <div class="content-section">
            <h3 class="section-title">Transport</h3>
            <div class="transport">
              <span class="transport-url">{transportInfo(server)}</span>
              {#if server.configTemplate.transport?.type}
                <span class="transport-type"
                  >{server.configTemplate.transport.type}</span
                >
              {/if}
            </div>
          </div>

          <!-- Required config -->
          {#if server.requiredConfig && server.requiredConfig.length > 0}
            <div class="content-section">
              <h3 class="section-title">Required configuration</h3>
              <SimpleTable>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {#each server.requiredConfig as field (field.key)}
                    <tr>
                      <th scope="row">{field.key}</th>
                      <td>{field.description}</td>
                    </tr>
                  {/each}
                </tbody>
              </SimpleTable>
            </div>
          {/if}

          {#if server.configTemplate}
            <div class="content-section credentials-section">
              <h3 class="section-title">Credentials</h3>
              <McpCredentialsPanel
                serverId={server.id}
                configTemplate={server.configTemplate}
              />
            </div>
          {/if}

          <div class="content-section">
            <h3 class="section-title">Workspaces</h3>
            <McpWorkspaceUsage serverId={server.id} />
          </div>

          <div class="content-section">
            <h3 class="section-title">Test Chat</h3>
            <McpTestChat serverId={server.id} />
          </div>

          {#if server.upstream}
            <div class="content-section">
              <h3 class="section-title">Upstream</h3>
              <div class="meta-grid">
                <div class="meta-item">
                  <span class="meta-label">Canonical name</span>
                  <span class="meta-value">{server.upstream.canonicalName}</span
                  >
                </div>
                <div class="meta-item">
                  <span class="meta-label">Version</span>
                  <span class="meta-value">{server.upstream.version}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Updated</span>
                  <span class="meta-value"
                    >{formatDate(server.upstream.updatedAt)}</span
                  >
                </div>
              </div>
            </div>
          {/if}

          <!-- Raw config — read-only. The root entry is frozen post-install. -->
          <div class="content-section">
            <button class="raw-config-toggle" onclick={toggleRawConfig}>
              {#if rawConfigOpen}
                <IconSmall.ChevronDown />
              {:else}
                <IconSmall.ChevronRight />
              {/if}
              View raw config
            </button>
            {#if rawConfigOpen}
              <pre class="raw-config-block">{rawConfigJson}</pre>
            {/if}
          </div>
        {/if}

        <!-- From the curators — curator markdown above the README. -->
        {#if curatorNotes}
          <div class="content-section">
            <h3 class="section-title">From the curators</h3>
            <div class="readme-content">
              <MarkdownRendered>
                {@html markdownToHTMLSafe(curatorNotes)}
              </MarkdownRendered>
            </div>
          </div>
        {/if}

        <!-- README -->
        {#if readme}
          <div class="content-section">
            <h3 class="section-title">Readme</h3>
            <div class="readme-content">
              <MarkdownRendered>
                {@html markdownToHTMLSafe(readme)}
              </MarkdownRendered>
            </div>
          </div>
        {/if}
      </div>
    </article>
  {/if}
</div>

<style>
  .detail-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .actions-bar {
    display: flex;
    align-items: center;
    gap: var(--size-3);
    position: absolute;
    inset-block-start: var(--size-1-5);
    inset-inline-end: var(--size-1-5);
    z-index: 1;

    .actions-int {
      background-color: var(--surface-dark);
      border-start-end-radius: var(--radius-6);
      border-end-start-radius: var(--radius-6);
      block-size: var(--size-8);
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
      position: absolute;
    }

    .actions-indent-br {
      block-size: 12px;
      clip-path: path("M12 12C12 5.37258 6.62742 0 0 0H12V12Z");
      inline-size: 12px;
      inset-block-start: 100%;
      inset-inline-end: 0;
      position: absolute;
    }
  }

  /* ─── Empty state ────────────────────────────────────────────────────────── */

  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-16);
  }

  .empty-icon {
    color: color-mix(in srgb, var(--text), transparent 60%);
  }

  .empty-icon :global(svg) {
    block-size: 40px;
    inline-size: 40px;
  }

  .empty-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .empty-desc {
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 48ch;
    text-align: center;
  }

  article {
    padding: var(--size-12);

    header {
      align-items: center;
      display: flex;
      flex-shrink: 0;
      gap: var(--size-3);

      h1 {
        color: var(--text-bright);
        font-size: var(--font-size-8);
        font-weight: var(--font-weight-6);
        letter-spacing: -0.01em;
        margin: 0;
        word-break: break-word;
      }
    }
  }

  /* ─── Header ─────────────────────────────────────────────────────────────── */

  .header-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  /* ─── TL;DR strip ────────────────────────────────────────────────────────── */

  .tldr-strip {
    background: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text-bright);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: var(--size-3) 0 0;
    padding: var(--size-2) var(--size-3);
  }

  /* ─── Content ────────────────────────────────────────────────────────────── */

  .detail-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-6);
  }

  .content-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .credentials-section:not(:has(> *:nth-child(2))) {
    display: none;
  }

  .section-title {
    color: var(--text-faded);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .description {
    color: var(--text);
    font-size: var(--font-size-5);
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 72ch;

    &.faded {
      color: var(--text-faded);
    }
  }

  /* ─── Doctor panels ──────────────────────────────────────────────────────── */

  .doctor-panel {
    background: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4);
  }

  .doctor-panel-warning {
    border-color: var(--yellow-primary);
  }

  .doctor-panel-desc {
    color: var(--text-faded);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 72ch;
  }

  .doctor-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .doctor-stream-error {
    color: var(--yellow-primary);
    font-size: var(--font-size-1);
    margin: 0;
  }

  /* ─── Phase list (setting_up) ────────────────────────────────────────────── */

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
    font-size: var(--font-size-2);
    gap: var(--size-2);
  }

  .phase-item[data-state="active"] {
    color: var(--text-bright);
    font-weight: var(--font-weight-5);
  }

  .phase-item[data-state="done"] {
    color: var(--green-primary);
  }

  .phase-icon {
    align-items: center;
    display: flex;
    flex-shrink: 0;
  }

  /* ─── Env var review list (awaiting_confirm) ─────────────────────────────── */

  .env-review-list,
  .env-summary-list,
  .findings-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .env-review-item,
  .env-summary-item {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: var(--size-2) var(--size-3);
  }

  .env-review-head {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .env-name {
    color: var(--text-bright);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .env-flags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .env-flag {
    background: var(--highlight);
    border-radius: var(--radius-2);
    color: var(--text-faded);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
    padding: 2px var(--size-1-5);
    text-transform: uppercase;
  }

  .env-flag-required {
    color: var(--yellow-primary);
  }

  .env-flag-secret {
    color: var(--purple-primary);
  }

  .env-flag-provenance {
    text-transform: none;
    letter-spacing: 0;
  }

  .env-description {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .env-excerpt {
    border-inline-start: 2px solid var(--border);
    color: var(--text-faded);
    font-size: var(--font-size-1);
    font-style: italic;
    line-height: 1.5;
    margin: 0;
    padding-inline-start: var(--size-2);
  }

  .env-summary-item {
    background: transparent;
  }

  /* ─── Findings list (unknown) ────────────────────────────────────────────── */

  .finding-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-inline-start: var(--size-2);
    border-inline-start: 2px solid var(--text-faded);
  }

  .finding-item[data-severity="warn"] {
    border-inline-start-color: var(--yellow-primary);
  }

  .finding-item[data-severity="error"] {
    border-inline-start-color: var(--red-primary);
  }

  .finding-title {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .finding-detail {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    line-height: 1.5;
  }

  /* ─── Clean note ─────────────────────────────────────────────────────────── */

  .clean-note {
    align-items: center;
    color: var(--text-faded);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
    margin: 0;
  }

  /* ─── Raw config ─────────────────────────────────────────────────────────── */

  .raw-config-toggle {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: flex;
    font-family: inherit;
    font-size: var(--font-size-2);
    gap: var(--size-1);
    padding: 0;
  }

  .raw-config-toggle:hover {
    color: var(--text-bright);
  }

  .raw-config-block {
    background: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    margin: 0;
    overflow-x: auto;
    padding: var(--size-3);
  }

  /* ─── Transport ──────────────────────────────────────────────────────────── */

  .transport {
    display: flex;
    flex-direction: column;
    gap: var(--size-px);
  }

  .transport-url {
    color: var(--text-bright);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    line-break: anywhere;
    word-break: break-word;
  }

  .transport-type {
    color: var(--text-faded);
    font-size: var(--font-size-3);
    text-transform: lowercase;
  }

  /* ─── Meta grid ──────────────────────────────────────────────────────────── */

  .meta-grid {
    display: grid;
    gap: var(--size-2) var(--size-6);
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .meta-label {
    color: color-mix(in srgb, var(--text), transparent 45%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .meta-value {
    color: var(--text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }
</style>
