<script lang="ts">
  import type { Color } from "@atlas/utils";
  import { createInfiniteQuery, createQuery } from "@tanstack/svelte-query";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { resolve } from "$app/paths";
  import ScrollListener from "$lib/components/scroll-listener.svelte";
  import { Table } from "$lib/components/table";
  import ActivityColumn from "$lib/modules/activity/activity-column.svelte";
  import { resetActivityCount } from "$lib/modules/activity/activity-stream.svelte";
  import UnreadDotColumn from "$lib/modules/activity/unread-dot-column.svelte";
  import { listActivity, markActivity, type ActivityWithReadStatus } from "$lib/queries/activity";
  import { listSpaces } from "$lib/queries/spaces";
  import { onMount } from "svelte";

  const PAGE_SIZE = 50;

  const spacesQuery = createQuery(() => ({ queryKey: ["spaces"], queryFn: () => listSpaces() }));

  const workspaceMap = $derived.by(() => {
    const map = new Map<string, { name: string; color: Color | undefined }>();
    for (const w of spacesQuery.data ?? []) {
      map.set(w.id, { name: w.name, color: w.metadata?.color });
    }
    return map;
  });

  const activityQuery = createInfiniteQuery(() => ({
    queryKey: ["activity"],
    queryFn: async ({ pageParam }) => await listActivity(pageParam),
    initialPageParam: 0 as number,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? lastPageParam + PAGE_SIZE : undefined,
    select: (data) => data.pages.flatMap((p) => p.activities),
  }));

  const activities = $derived(activityQuery.data ?? []);

  type ActivityRow = ActivityWithReadStatus & {
    workspaceName: string | undefined;
    workspaceColor: Color | undefined;
  };

  const rows: ActivityRow[] = $derived(
    activities.map((a) => {
      const ws = workspaceMap.get(a.workspaceId);
      return { ...a, workspaceName: ws?.name, workspaceColor: ws?.color };
    }),
  );

  const columnHelper = createColumnHelper<ActivityRow>();

  const table = createTable({
    get data() {
      return rows;
    },
    columns: [
      columnHelper.display({
        id: "activity",
        cell: (info) =>
          renderComponent(ActivityColumn, {
            title: info.row.original.title,
            workspaceName: info.row.original.workspaceName,
            workspaceColor: info.row.original.workspaceColor,
            createdAt: info.row.original.createdAt,
          }),
        meta: { minWidth: "0" },
      }),
      columnHelper.display({
        id: "unread",
        cell: (info) =>
          renderComponent(UnreadDotColumn, {
            readStatus: info.row.original.readStatus,
            type: info.row.original.type,
            createdAt: info.row.original.createdAt,
          }),
        meta: { shrink: true, align: "center" },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  function getRowPath(item: ActivityRow): string | undefined {
    if (item.type === "session") {
      return resolve("/sessions/[sessionId]", { sessionId: item.referenceId });
    }
    if (item.type === "resource") {
      return resolve("/library/[artifactId]", { artifactId: item.referenceId });
    }
    return undefined;
  }

  function handleRowClick(item: ActivityRow) {
    markActivity({ activityIds: [item.id], status: "dismissed" });
  }

  onMount(() => {
    markActivity({ before: new Date().toISOString(), status: "viewed" }).then(() => {
      resetActivityCount();
    });
  });
</script>

<div class="page">
  <div class="header">
    <h1>Activity</h1>
    <p>Catch up on what’s happened recently</p>
  </div>

  {#if !activityQuery.isLoading && activities.length === 0}
    <p>No activity found</p>
  {:else}
    <ScrollListener
      requestLoadItems={() => activityQuery.fetchNextPage()}
      hasMoreItems={activityQuery.hasNextPage}
      cursor={activityQuery.data}
      isFetching={activityQuery.isFetchingNextPage}
    >
      <Table.Root
        {table}
        hideHeader
        rowSize="large"
        rowPath={(item) => getRowPath(item)}
        onRowClick={(item) => handleRowClick(item)}
        padded
      />
    </ScrollListener>
  {/if}
</div>

<style>
  .page {
    overflow: auto;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  .header {
    margin-block-end: var(--size-7);
  }

  h1 {
    font-size: var(--font-size-8);
    line-height: var(--font-lineheight-1);
    font-weight: var(--font-weight-6);
  }

  p {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-1);
    margin-block: var(--size-1) 0;
    opacity: 0.6;
  }
</style>
