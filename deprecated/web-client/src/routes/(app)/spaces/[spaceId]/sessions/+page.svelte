<script lang="ts">
  import type { SessionStatus } from "@atlas/core/session/session-events";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { getAppContext } from "$lib/app-context.svelte.ts";
  import { Table } from "$lib/components/table";
  import { DetailsColumn, StatusColumn, TimeColumn } from "$lib/modules/sessions/table-columns";
  import Breadcrumbs from "../(components)/breadcrumbs.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const sessions = $derived(data.sessions);
  const appCtx = getAppContext();

  const columnHelper = createColumnHelper<{
    sessionId: string;
    workspaceId: string;
    jobName: string;
    task: string;
    status: SessionStatus;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    stepCount: number;
    agentNames: string[];
  }>();

  const columns = [
    columnHelper.display({
      id: "deployment",
      header: "Deployment",
      cell: (info) => {
        return renderComponent(DetailsColumn, {
          job: info.row.original.jobName,
          summary: info.row.original.task,
          status: info.row.original.status,
        });
      },
      meta: { minWidth: "0" },
    }),
    columnHelper.accessor("startedAt", {
      id: "startedAt",
      header: "Date",
      cell: (info) => renderComponent(TimeColumn, { date: info.getValue() }),
      meta: { align: "center", faded: true, shrink: true, size: "small" },
    }),
    columnHelper.accessor("status", {
      id: "status",
      cell: (info) => renderComponent(StatusColumn, { status: info.getValue() }),
      meta: { align: "center", faded: true, shrink: true, size: "small" },
      enableSorting: false,
    }),
  ];

  const table = createTable({
    get data() {
      return sessions;
    },
    columns: columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.sessionId,
  });
</script>

<Breadcrumbs workspace={data.workspace} />

<div class="page">
  <div class="content">
    {#if sessions.length === 0}
      <p class="empty">No sessions yet</p>
    {:else}
      <Table.Root
        {table}
        rowSize="large"
        rowPath={(item) =>
          appCtx.routes.spaces.item(data.workspace.id, `sessions/${item.sessionId}`)}
        hideHeader
      />
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    block-size: 100%;
    inline-size: 100%;
  }

  .content {
    flex: 1;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  .empty {
    color: var(--text-3);
    font-size: var(--font-size-3);
  }
</style>
