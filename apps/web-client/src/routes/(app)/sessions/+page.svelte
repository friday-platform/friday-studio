<script lang="ts">
  import type { ReasoningResultStatusType } from "@atlas/core";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { resolve } from "$app/paths";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Table } from "$lib/components/table";
  import { DetailsColumn, TimeColumn } from "$lib/modules/sessions/table-columns";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const sessions = $derived(data.sessions);

  const columnHelper = createColumnHelper<{
    sessionId: string;
    workspaceId: string;
    workspaceName?: string;
    status: ReasoningResultStatusType;
    createdAt: string;
    updatedAt: string;
    summary?: string | undefined;
    title?: string | undefined;
    sessionType?: "conversation" | "task";
    parentStreamId?: string;
    parentTitle?: string;
  }>();

  const table = createTable({
    get data() {
      return sessions;
    },
    columns: [
      columnHelper.display({
        id: "deployment",
        header: "Deployment",
        cell: (info) => {
          return renderComponent(DetailsColumn, {
            job: info.row.original.sessionId,
            summary: info.row.original.summary ?? "",
            workspaceName: info.row.original.workspaceName,
            sessionType: info.row.original.sessionType,
            parentTitle: info.row.original.parentTitle,
            status: info.row.original.status,
          });
        },
        meta: { minWidth: "0" },
      }),
      columnHelper.accessor("createdAt", {
        id: "createdAt",
        header: "Date",
        cell: (info) => renderComponent(TimeColumn, { date: info.getValue() }),
        meta: { align: "center", faded: true, shrink: true, size: "small" },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.sessionId,
  });
</script>

<Breadcrumbs.Root>
  <Breadcrumbs.Item href="/sessions">Sessions</Breadcrumbs.Item>
</Breadcrumbs.Root>

<div class="page">
  {#if sessions.length === 0}
    <p class="empty">No sessions yet</p>
  {:else}
    <Table.Root
      {table}
      hideHeader
      rowSize="large"
      rowPath={(item) => resolve("/sessions/[sessionId]", { sessionId: item.sessionId })}
    />
  {/if}
</div>

<style>
  .page {
    overflow: auto;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  .empty {
    color: var(--text-3);
    font-size: var(--font-size-3);
  }
</style>
