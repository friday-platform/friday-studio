<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import type { ReasoningResultStatusType } from "@atlas/core";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { getAppContext } from "$lib/app-context.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import { Table } from "$lib/components/table";
  import { artifactColumns } from "$lib/modules/library/columns";
  import { DetailsColumn, StatusColumn, TimeColumn } from "$lib/modules/sessions/table-columns";
  import { onMount } from "svelte";
  import Breadcrumbs from "./(components)/breadcrumbs.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const appCtx = getAppContext();
  const workspace = $derived(data.workspace);
  const recentSessions = $derived(data.sessions.slice(0, 3));
  const recentArtifacts = $derived(data.artifacts.slice(0, 5));

  // Sessions table
  const sessionColumnHelper = createColumnHelper<{
    sessionId: string;
    workspaceId: string;
    status: ReasoningResultStatusType;
    createdAt: string;
    updatedAt: string;
    summary?: string | undefined;
    title?: string | undefined;
    sessionType?: "conversation" | "task";
    parentTitle?: string;
  }>();

  const sessionColumns = [
    sessionColumnHelper.display({
      id: "deployment",
      header: "Deployment",
      cell: (info) => {
        return renderComponent(DetailsColumn, {
          job: info.row.original.sessionId,
          summary: info.row.original.summary ?? "",
          title: info.row.original.title,
          sessionType: info.row.original.sessionType,
          parentTitle: info.row.original.parentTitle,
        });
      },
      meta: { minWidth: "0" },
    }),
    sessionColumnHelper.accessor("createdAt", {
      id: "createdAt",
      header: "Date",
      cell: (info) => renderComponent(TimeColumn, { date: info.getValue() }),
      meta: { align: "center", faded: true, shrink: true, size: "small" },
    }),
    sessionColumnHelper.accessor("status", {
      id: "status",
      cell: (info) => renderComponent(StatusColumn, { status: info.getValue() }),
      meta: { align: "center", faded: true, shrink: true, size: "small" },
      enableSorting: false,
    }),
  ];

  const sessionsTable = createTable({
    get data() {
      return recentSessions;
    },
    columns: sessionColumns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.sessionId,
  });

  const artifactsTable = createTable({
    get data() {
      return recentArtifacts;
    },
    columns: artifactColumns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  onMount(() => {
    trackEvent(GA4.SPACE_VIEW, { space_id: workspace.id, space_name: workspace.name });
  });
</script>

<Breadcrumbs {workspace} />

<div class="page">
  <div class="content">
    <h1>{workspace.name}</h1>

    <MarkdownContent>
      {#if workspace.description}
        <p>{workspace.description}</p>
      {/if}

      {#if recentArtifacts.length > 0}
        <h2>Artifacts</h2>
        <div data-tempest class="artifacts">
          <Table.Root
            table={artifactsTable}
            rowSize="large"
            rowPath={(item) => `/library/${item.id}`}
            onRowClick={(item) =>
              trackEvent(GA4.SPACE_ARTIFACT_CLICK, {
                space_id: workspace.id,
                artifact_id: item.id,
              })}
            hideHeader
          />
        </div>
      {/if}

      {#if recentSessions.length > 0}
        <h2>Sessions</h2>
        <div data-tempest class="sessions">
          <Table.Root
            table={sessionsTable}
            rowSize="large"
            rowPath={(item) =>
              appCtx.routes.spaces.item(workspace.id, `sessions/${item.sessionId}`)}
            hideHeader
          />
        </div>
      {/if}
    </MarkdownContent>
  </div>

  <aside class="sidebar">
    {#if workspace.config?.jobs}
      <div class="sidebar-section">
        <h2 class="sidebar-label">Jobs</h2>
        <ul class="sidebar-list">
          {#each Object.keys(workspace.config.jobs) as jobId (jobId)}
            <li class="sidebar-item">
              {workspace.config.jobs[jobId].title ||
                workspace.config.jobs[jobId].description ||
                workspace.config.jobs[jobId].name ||
                jobId}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if workspace.config?.signals}
      <div class="sidebar-section">
        <h2 class="sidebar-label">Signals</h2>
        <ul class="sidebar-list">
          {#each Object.keys(workspace.config.signals) as signalId (signalId)}
            <li class="sidebar-item">
              {workspace.config.signals[signalId].title ||
                workspace.config.signals[signalId].description ||
                signalId}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </aside>
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: 1fr var(--size-56);
    inline-size: 100%;
    gap: var(--size-6);
    overflow: auto;
  }

  .content {
    flex: 1;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    margin-bottom: var(--size-4);
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--size-7);
    inline-size: 228px;
    padding-block: var(--size-12);
    padding-inline: 0 var(--size-14);
    position: sticky;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .sidebar-label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-0);
    margin: 0;
    opacity: 0.6;
  }

  .sidebar-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .sidebar-item {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    text-wrap-style: balance;
    word-break: break-word;
  }

  .artifacts {
    margin-block-end: var(--size-8);
  }

  .sessions {
    margin-block-start: var(--size-3);
  }
</style>
