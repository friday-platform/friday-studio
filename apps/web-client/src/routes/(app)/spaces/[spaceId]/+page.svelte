<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import type { Color } from "@atlas/utils";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "$lib/components/button.svelte";
  import Dot from "$lib/components/dot.svelte";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import { Page } from "$lib/components/page";
  import { getFeatureFlags } from "$lib/feature-flags.svelte";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import { listWorkspaceJobs } from "$lib/queries/jobs";
  import { listWorkspaceSessions } from "$lib/queries/sessions";
  import { formatChatDate } from "$lib/utils/date";
  import NewChat from "./(components)/new-chat.svelte";
  import RunJobDialog from "./(components)/run-job-dialog.svelte";
  import Setup from "./(components)/setup.svelte";
  import ShareActions from "./(components)/share-actions.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let queryClient = useQueryClient();

  const featureFlags = getFeatureFlags();

  const COLORS: Color[] = ["yellow", "green", "blue", "red", "purple", "brown"];

  const workspace = $derived(data.workspace);

  const sessionsQuery = createQuery(() => ({
    queryKey: ["sessions", workspace.id],
    queryFn: () => listWorkspaceSessions(workspace.id),
    initialData: data.sessions,
    refetchInterval: 10_000,
  }));
  const recentSessions = $derived((sessionsQuery.data ?? []).slice(0, 3));
  const recentArtifacts = $derived(data.artifacts.slice(0, 5));
  const resources = $derived(data.resources);

  const jobsQuery = createQuery(() => ({
    queryKey: ["jobs", workspace.id],
    queryFn: () => listWorkspaceJobs(workspace.id),
    refetchInterval: 10_000,
  }));

  $effect(() => {
    trackEvent(GA4.SPACE_VIEW, { space_id: workspace.id, space_name: workspace.name });
  });

  /** Look up the full job config by API job id, needed for RunJobDialog. */
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

      {#if jobsQuery.data?.length}
        <section class="jobs">
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

      {#if featureFlags.ENABLE_WORKSPACE_PAGE_CONVERSATIONS}
        <NewChat workspaceId={workspace.id} />
      {/if}
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
        {/if}
      </div>

      <div class="section">
        <h2>Recent Activity</h2>

        {#if recentSessions.length > 0}
          <div class="sessions">
            <ul>
              {#each recentSessions as session (session.sessionId)}
                {@const displayName = session.jobName || session.task || session.sessionId}
                {@const isRunning = session.status === "active"}
                {@const isFailed = session.status === "failed"}

                <li>
                  <a href={resolve("/sessions/[sessionId]", { sessionId: session.sessionId })}>
                    <span class="session-name">
                      {displayName}
                      {#if isRunning}
                        <span class="running-tag">
                          <IconSmall.Progress />
                          Running
                        </span>
                      {:else if isFailed}
                        <span class="failed-tag">
                          <IconSmall.Close />
                          Failed
                        </span>
                      {/if}
                    </span>

                    <time>{formatChatDate(session.startedAt)}</time>
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
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

  .sessions {
    a {
      block-size: var(--size-16);
      border-block-end: var(--size-px) solid var(--accent-1);
      display: flex;
      flex-direction: column;
      gap: var(--size-0-5);
      justify-content: center;
      position: relative;
      z-index: 1;

      .session-name {
        align-items: center;
        display: flex;
        font-size: var(--font-size-3);
        font-weight: var(--font-weight-5);
        gap: var(--size-1);
      }

      time {
        font-size: var(--font-size-2);
        opacity: 0.6;
      }

      &:before {
        background-color: var(--accent-1);
        border-radius: var(--radius-4);
        content: "";
        inset-block: 0;
        inset-inline: calc(-1 * var(--size-3));
        opacity: 0;
        position: absolute;
        transition:
          opacity 200ms ease,
          visibility 200ms ease;
        visibility: hidden;
        z-index: -1;
      }

      &:hover:before {
        opacity: 1;
        visibility: visible;
      }
    }

    .running-tag,
    .failed-tag {
      align-items: center;
      border-radius: var(--radius-2-5);
      display: inline-flex;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      gap: var(--size-0-5);
      padding-block: var(--size-0-5);
      padding-inline: var(--size-1) var(--size-1-5);
      white-space: nowrap;
    }

    .running-tag {
      background: color-mix(in srgb, var(--color-yellow) 10%, transparent);
      color: var(--color-yellow-2);

      & :global(svg) {
        animation: spin 1.2s linear infinite;
      }
    }

    .failed-tag {
      background: color-mix(in srgb, var(--color-red) 7%, transparent);
      color: var(--color-red);
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
