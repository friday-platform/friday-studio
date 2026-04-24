<script lang="ts">
  import { createInfiniteQuery, useQueryClient } from "@tanstack/svelte-query";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { resolve } from "$app/paths";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import Dot from "$lib/components/dot.svelte";
  import ScrollListener from "$lib/components/scroll-listener.svelte";
  import { Table } from "$lib/components/table";
  import ActivityColumn from "$lib/modules/activity/activity-column.svelte";
  import UnreadDotColumn from "$lib/modules/activity/unread-dot-column.svelte";
  import {
    listWorkspaceActivity,
    markActivity,
    type ActivityWithReadStatus,
  } from "$lib/queries/activity";
  import { onMount } from "svelte";
  import type { PageData } from "./$types";

  const appCtx = getAppContext();

  let { data }: { data: PageData } = $props();

  const workspace = $derived(data.workspace);

  const PAGE_SIZE = 50;

  const queryClient = useQueryClient();

  const activityQuery = createInfiniteQuery(() => ({
    queryKey: ["workspace-activity-full", workspace.id],
    queryFn: async ({ pageParam }) =>
      await listWorkspaceActivity(workspace.id, { offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0 as number,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? lastPageParam + PAGE_SIZE : undefined,
    select: (data) => data.pages.flatMap((p) => p.activities),
  }));

  const activities = $derived(activityQuery.data ?? []);

  const columnHelper = createColumnHelper<ActivityWithReadStatus>();

  const table = createTable({
    get data() {
      return activities;
    },
    columns: [
      columnHelper.display({
        id: "activity",
        cell: (info) =>
          renderComponent(ActivityColumn, {
            title: info.row.original.title,
            workspaceName: undefined,
            workspaceColor: workspace.metadata?.color,
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

  function getRowPath(item: ActivityWithReadStatus): string | undefined {
    if (item.type === "session") {
      return resolve("/sessions/[sessionId]", { sessionId: item.referenceId });
    }
    if (item.type === "resource") {
      return resolve("/library/[artifactId]", { artifactId: item.referenceId });
    }
    return undefined;
  }

  function handleRowClick(item: ActivityWithReadStatus) {
    markActivity({ activityIds: [item.id], status: "dismissed" });
  }

  onMount(() => {
    markActivity({
      before: new Date().toISOString(),
      status: "viewed",
      workspaceId: workspace.id,
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ["workspace-activity", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspace-unread", workspace.id] });
    });
  });
</script>

<Breadcrumbs.Root fixed>
  <Breadcrumbs.Item href={appCtx.routes.spaces.item(workspace.id)} showCaret>
    {#snippet prepend()}
      <Dot color={workspace.metadata?.color} />
    {/snippet}
    {workspace.name}
  </Breadcrumbs.Item>
</Breadcrumbs.Root>

<div class="page">
  <div class="header">
    <h1>Activity</h1>
    <p>Catch up on what's happened recently</p>
  </div>

  {#if !activityQuery.isLoading && activities.length === 0}
    <p>No activity found</p>
  {:else}
    <div class="activity-table">
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
    </div>
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

  .activity-table {
    margin-inline: calc(-1 * var(--size-2));
  }
</style>
