<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import type { Color } from "@atlas/utils";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "$lib/components/button.svelte";
  import Dot from "$lib/components/dot.svelte";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import { Page } from "$lib/components/page";
  import { Table } from "$lib/components/table";
  import ActivityColumn from "$lib/modules/activity/activity-column.svelte";
  import UnreadDotColumn from "$lib/modules/activity/unread-dot-column.svelte";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import { toSlackBotDisplayName } from "$lib/modules/integrations/utils";
  import {
    getWorkspaceUnreadCount,
    listWorkspaceActivity,
    markActivity,
    type ActivityWithReadStatus,
  } from "$lib/queries/activity";
  import { listWorkspaceJobs } from "$lib/queries/jobs";
  import ConnectSlack from "./(components)/connect-slack.svelte";
  import DisconnectSlack from "./(components)/disconnect-slack.svelte";
  import NewChat from "./(components)/new-chat.svelte";
  import PendingRevision from "./(components)/pending-revision.svelte";
  import RunJobDialog from "./(components)/run-job-dialog.svelte";
  import Setup from "./(components)/setup.svelte";
  import ShareActions from "./(components)/share-actions.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let queryClient = useQueryClient();

  const COLORS: Color[] = ["yellow", "green", "blue", "red", "purple", "brown"];

  const workspace = $derived(data.workspace);

  const recentArtifacts = $derived(data.artifacts.slice(0, 5));
  const resources = $derived(data.resources);

  const hasSlackBot = $derived.by(() => {
    const signals = workspace.config?.signals;
    if (!signals) return false;
    return Object.values(signals).some((s) => s.provider === "slack");
  });

  const connectedAccounts = $derived(
    data.integrations
      .filter((i) => i.connected && i.credential)
      .map((i) => ({
        provider: i.provider,
        displayName: i.provider
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        label: i.credential?.displayName ?? i.credential?.label,
      })),
  );

  const jobsQuery = createQuery(() => ({
    queryKey: ["jobs", workspace.id],
    queryFn: () => listWorkspaceJobs(workspace.id),
    refetchInterval: 10_000,
  }));

  const activityQuery = createQuery(() => ({
    queryKey: ["workspace-activity", workspace.id],
    queryFn: () => listWorkspaceActivity(workspace.id, { limit: 6 }),
    refetchInterval: 10_000,
  }));

  const unreadQuery = createQuery(() => ({
    queryKey: ["workspace-unread", workspace.id],
    queryFn: () => getWorkspaceUnreadCount(workspace.id),
    refetchInterval: 10_000,
  }));

  const activities = $derived(activityQuery.data?.activities ?? []);
  const unreadCount = $derived(unreadQuery.data ?? 0);

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

  $effect(() => {
    trackEvent(GA4.SPACE_VIEW, { space_id: workspace.id, space_name: workspace.name });
  });

  function getJobConfig(jobId: string) {
    const jobs = workspace.config?.jobs ?? {};
    return jobs[jobId];
  }

  async function handleUpdateColor(color: Color) {
    const res = await parseResult(
      client.workspace[":workspaceId"].metadata.$patch({
        param: { workspaceId: workspace.id },
        json: { color },
      }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    }
  }
</script>

{#if data.requiresSetup}
  <Setup {workspace} integrations={data.integrations} />
{:else}
  <Page.Root>
    <Page.Content>
      {#snippet badge()}
        {#if unreadCount > 0}
          <a
            class="updates-badge"
            href={resolve("/spaces/[spaceId]/activity", { spaceId: workspace.id })}
          >
            {unreadCount}
            {unreadCount === 1 ? "update" : "updates"}
          </a>
        {/if}
      {/snippet}

      {#snippet header()}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <span class="change-color">
              <Dot color={workspace.metadata?.color} />
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {#each COLORS as color (color)}
              <DropdownMenu.Item
                accent="inherit"
                checked={workspace.metadata?.color === color}
                onclick={() => handleUpdateColor(color)}
              >
                <span style:color="var(--{color}-2)">
                  <Icons.DotFilled />
                </span>

                <span class="color-label">{color}</span>
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <h1>{workspace.name}</h1>
      {/snippet}

      {#snippet description()}
        {#if workspace.description}
          <p>{workspace.description}</p>
        {/if}
      {/snippet}

      <NewChat workspaceId={workspace.id} />

      {#if jobsQuery.data?.length}
        <section class="jobs">
          <h2 class="section-heading">Jobs</h2>
          <div class="jobs-grid">
            {#each jobsQuery.data as job (job.id)}
              {@const jobConfig = getJobConfig(job.id)}

              <div class="job-card">
                {#if job.integrations.length > 0}
                  <div class="job-integrations">
                    {#each job.integrations as integration (integration)}
                      {@const icon = getServiceIcon(integration)}
                      {#if icon}
                        <span class="job-integration-icon">
                          {#if icon.type === "component"}
                            {@const Component = icon.src}
                            <Component />
                          {:else}
                            <img src={icon.src} alt={integration} />
                          {/if}
                        </span>
                      {/if}
                    {/each}
                  </div>
                {/if}

                <h3>{job.name}</h3>

                {#if job.description}
                  <p class="job-description">{job.description}</p>
                {/if}

                <div class="job-actions">
                  {#if jobConfig}
                    <RunJobDialog
                      jobId={job.id}
                      job={jobConfig}
                      signals={workspace.config?.signals ?? {}}
                      workspaceId={workspace.id}
                    >
                      {#snippet triggerContents()}
                        <Button size="small">Run</Button>
                      {/snippet}
                    </RunJobDialog>
                  {/if}

                  <Button
                    size="small"
                    variant="secondary"
                    href={resolve("/spaces/[spaceId]/jobs/[jobId]", {
                      spaceId: workspace.id,
                      jobId: job.id,
                    })}
                  >
                    View
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {:else if jobsQuery.isError}
        <p class="jobs-error">Failed to load jobs.</p>
      {/if}

      <section class="activity-section">
        <div class="activity-header">
          <h2>Activity</h2>
          <a href={resolve("/spaces/[spaceId]/activity", { spaceId: workspace.id })}>View all</a>
        </div>

        {#if !activityQuery.isLoading && activities.length === 0}
          <p class="activity-empty">No activity yet</p>
        {:else if activities.length > 0}
          <div class="activity-table">
            <Table.Root
              {table}
              hideHeader
              rowSize="large"
              rowPath={(item) => getRowPath(item)}
              onRowClick={(item) => handleRowClick(item)}
              padded
            />
          </div>
        {/if}
      </section>
    </Page.Content>

    <Page.Sidebar>
      <div class="actions">
        <a href={resolve("/spaces/[spaceId]/edit", { spaceId: workspace.id })}>
          <Icons.Settings />
          Edit Space
        </a>

        <ShareActions {workspace} />
      </div>

      <div class="section">
        <h2>Resources</h2>

        {#if resources.length > 0 || recentArtifacts.length > 0}
          <ul class="resources">
            {#each resources as resource (resource.slug)}
              <li>
                <a
                  href={resolve("/spaces/[spaceId]/resources/[slug]", {
                    spaceId: workspace.id,
                    slug: resource.slug,
                  })}
                >
                  <span>
                    {resource.name}
                  </span>

                  <IconSmall.CaretRight />
                </a>
              </li>
            {/each}
            {#each recentArtifacts as artifact (artifact.id)}
              <li>
                <a href={resolve("/library/[libraryId]", { libraryId: artifact.id })}>
                  <span>
                    {artifact.title}
                  </span>

                  <IconSmall.CaretRight />
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <a
            class="sidebar-link"
            href="https://docs.hellofriday.ai/core-concepts/resources"
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn more about Resources
          </a>
        {/if}
      </div>

      <div class="section">
        <h2>Accounts</h2>

        {#if connectedAccounts.length > 0}
          <ul class="accounts-list">
            {#each connectedAccounts as account (account.provider)}
              {@const icon = getServiceIcon(account.provider)}
              <li class="account-item">
                {#if icon}
                  <span class="account-icon">
                    {#if icon.type === "component"}
                      <icon.src />
                    {:else}
                      <img src={icon.src} alt="" />
                    {/if}
                  </span>
                {/if}
                <div class="account-info">
                  <span>{account.displayName}</span>
                  {#if account.label}
                    <span class="account-label">{account.label}</span>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <a
            class="sidebar-link"
            href="https://docs.hellofriday.ai/capabilities-and-integrations/overview"
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn about Accounts and Integrations
          </a>
        {/if}
      </div>

      <div class="section">
        <h2>Communicators</h2>

        <div class="communicator-row">
          <span class="communicator-icon">
            <Icons.Slack />
          </span>
          {#if hasSlackBot}
            <span class="communicator-mention">
              @{toSlackBotDisplayName(workspace.name)}
            </span>
            <DisconnectSlack workspaceId={workspace.id} />
          {:else}
            <ConnectSlack workspaceId={workspace.id} compact />
          {/if}
        </div>
      </div>

      {#if workspace.metadata?.pendingRevision}
        <PendingRevision
          workspaceId={workspace.id}
          pendingRevision={workspace.metadata.pendingRevision}
        />
      {/if}
    </Page.Sidebar>
  </Page.Root>
{/if}

<style>
  .change-color {
    display: block;
    position: relative;
    z-index: 1;

    &:before {
      background-color: var(--accent-1);
      border-radius: var(--radius-2);
      content: "";
      inset: calc(-1 * var(--size-1));
      opacity: 0;
      position: absolute;
      transition: all 200ms ease;
      z-index: -1;
    }
  }

  .change-color:hover:before,
  :global(:focus-visible) .change-color:before,
  :global([data-melt-dropdown-menu-trigger][data-state="open"]) .change-color:before {
    opacity: 1;
    visibility: visible;
  }

  .jobs-grid {
    display: grid;
    gap: var(--size-4);
    grid-template-columns: repeat(auto-fill, minmax(var(--size-64), 1fr));
    margin-block-start: var(--size-4);
  }

  .job-card {
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);

    h3 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }

    .job-description {
      font-size: var(--font-size-3);
      line-height: var(--font-lineheight-3);
      opacity: 0.8;
    }
  }

  .job-integrations {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .job-integration-icon {
    color: var(--color-text);
    display: flex;

    & :global(svg),
    img {
      block-size: var(--size-4);
      inline-size: var(--size-4);
      object-fit: contain;
    }
  }

  .job-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    margin-block-start: var(--size-1);
  }

  .jobs-error {
    font-size: var(--font-size-3);
    opacity: 0.6;
  }

  .actions {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin: calc(-1 * var(--size-5));
    margin-block-end: 0;

    & :global(svg) {
      opacity: 0.5;
    }

    a {
      color: color-mix(in srgb, var(--color-text), transparent 20%);
      display: flex;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      gap: var(--size-1-5);
    }
  }

  .section {
    h2 {
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      opacity: 0.6;
    }
  }

  .resources {
    margin-block: var(--size-2) 0;

    a {
      align-items: center;
      color: color-mix(in srgb, var(--color-text), transparent 20%);
      display: flex;
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
      inline-size: max-content;
      line-height: var(--font-lineheight-5);
      max-inline-size: 100%;
      position: relative;
      z-index: 1;

      span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        text-wrap: nowrap;
      }

      & :global(svg) {
        flex: none;
        opacity: 0.5;
      }

      &:before {
        background-color: var(--accent-1);
        border-radius: var(--radius-2);
        content: "";
        inset-block: calc(-1 * var(--size-px));
        inset-inline: calc(-1 * var(--size-1-5));
        opacity: 0;
        position: absolute;
        transition:
          opacity 200ms ease,
          visibility 200ms ease;
        visibility: hidden;
        z-index: -1;
      }

      &:focus {
        outline: none;
      }

      &:hover:before,
      &:focus:before {
        opacity: 1;
        visibility: visible;
      }
    }
  }

  .updates-badge {
    align-items: center;
    background-color: var(--accent-1);
    block-size: var(--size-5-5);
    border-radius: var(--radius-3);
    color: var(--accent-3);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    inline-size: max-content;
    padding-inline: var(--size-2-5);
  }

  .activity-table {
    margin-inline: calc(-1 * var(--size-2));
  }

  .section-heading {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
  }

  .activity-header {
    align-items: baseline;
    display: flex;
    justify-content: space-between;
    margin-block-end: var(--size-3);

    h2 {
      font-size: var(--font-size-7);
      font-weight: var(--font-weight-6);
    }

    a {
      color: var(--color-blue);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }
  }

  .activity-empty {
    font-size: var(--font-size-3);
    opacity: 0.6;
  }

  .sidebar-link {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.6;
    text-decoration: underline;
    transition: opacity 150ms ease;

    &:hover {
      opacity: 1;
    }
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: var(--size-2) 0 0;
    padding: 0;
  }

  .account-item {
    align-items: start;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
  }

  .account-icon {
    block-size: var(--size-4);
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-4);
    margin-block-start: var(--size-px);

    :global(img) {
      block-size: 100%;
      inline-size: 100%;
      object-fit: contain;
    }
  }

  .account-info {
    display: flex;
    flex-direction: column;
  }

  .account-label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    opacity: 0.6;
  }

  .communicator-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    margin-block: var(--size-2) 0;
  }

  .communicator-icon {
    block-size: var(--size-4);
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-4);

    :global(svg) {
      block-size: 100%;
      inline-size: 100%;
    }
  }

  .communicator-mention {
    flex-grow: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
