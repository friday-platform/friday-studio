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
  import { listWorkspaceSessions } from "$lib/queries/sessions";
  import { formatChatDate } from "$lib/utils/date";
  import { onMount } from "svelte";
  import RunJobDialog from "./(components)/run-job-dialog.svelte";
  import Setup from "./(components)/setup.svelte";
  import ShareActions from "./(components)/share-actions.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let queryClient = useQueryClient();

  const COLORS: Color[] = ["yellow", "green", "blue", "red", "purple", "brown"];

  const workspace = $derived(data.workspace);

  const sessionsQuery = createQuery(() => ({
    queryKey: ["sessions", workspace.id],
    queryFn: () => listWorkspaceSessions(workspace.id),
    initialData: data.sessions,
    refetchInterval: 10_000,
  }));

  onMount(() => {
    trackEvent(GA4.SPACE_VIEW, { space_id: workspace.id, space_name: workspace.name });
  });

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
  {@const recentSessions = (sessionsQuery.data ?? []).slice(0, 3)}
  {@const recentArtifacts = data.artifacts.slice(0, 5)}
  {@const runnableJobs = Object.entries(workspace.config?.jobs ?? {}).filter(
    ([_, job]) => job.triggers && job.triggers.length > 0,
  )}

  <div class="wrapper">
    <div class="page">
      <article class="content">
        <header>
          <div class="title">
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
          </div>

          {#if workspace.description}
            <p>{workspace.description}</p>
          {/if}
        </header>
      </article>
    </div>

    <aside class="sidebar">
      <div class="actions">
        <a href={resolve("/spaces/[spaceId]/edit", { spaceId: workspace.id })}>
          <Icons.Settings />
          Edit Space
        </a>

        <ShareActions {workspace} />
      </div>
      {#if runnableJobs.length > 0}
        {#each runnableJobs as [jobId, job] (jobId)}
          <div class="section">
            <div class="section-header">
              <h2>{job.title || job.name || jobId}</h2>
            </div>

            {#if job.description}
              <p>{job.description}</p>
            {/if}

            <div class="job-action">
              <RunJobDialog
                {jobId}
                {job}
                signals={workspace.config?.signals ?? {}}
                workspaceId={workspace.id}
              >
                {#snippet triggerContents()}
                  <Button size="small">Run Now</Button>
                {/snippet}
              </RunJobDialog>
            </div>
          </div>
        {/each}
      {/if}

      <div class="section">
        <h2>Resources</h2>

        {#if recentArtifacts.length > 0}
          <ul class="resources">
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
                {@const isRunning = session.status === "partial" || session.status === "active"}
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
    </aside>
  </div>
{/if}

<style>
  .wrapper {
    block-size: 100%;
    display: grid;
    grid-template-columns: 2fr minmax(var(--size-80), 1fr);
    inline-size: 100%;

    @media (min-width: 1920px) {
      grid-template-columns: 1fr var(--size-112);
    }
  }

  .page {
    overflow: auto;
    padding-inline: 0 var(--size-14);
    scrollbar-width: thin;
  }

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

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--size-10);
    flex: 1;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);

    header {
      .title {
        align-items: center;
        display: flex;
        gap: var(--size-3);
      }

      h1 {
        font-size: var(--font-size-7);
        font-weight: var(--font-weight-6);
      }

      p {
        font-size: var(--font-size-5);
        font-weight: var(--font-weight-5);
        line-height: var(--font-lineheight-3);
        margin-block: var(--size-1-5) 0;
        max-inline-size: 80ch;
        opacity: 0.6;
        text-wrap-style: balance;
      }
    }
  }

  .sidebar {
    border-inline-start: var(--size-px) solid var(--accent-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-10);
    inline-size: 100%;
    min-inline-size: var(--size-80);
    padding: var(--size-10);

    .actions {
      align-items: center;
      display: flex;
      margin: calc(-1 * var(--size-5));
      margin-block-end: 0;
      justify-content: space-between;

      & :global(svg) {
        opacity: 0.5;
      }

      a {
        display: flex;
        color: color-mix(in srgb, var(--color-text), transparent 20%);
        font-size: var(--font-size-2);
        font-weight: var(--font-weight-5);
        gap: var(--size-1-5);
      }
    }

    .section {
      h2 {
        font-size: var(--font-size-5);
        font-weight: var(--font-weight-6);
      }

      p {
        font-size: var(--font-size-4);
        line-height: var(--font-lineheight-3);
        margin-block: var(--size-1-5) 0;
        opacity: 0.8;
        text-wrap-style: balance;
      }
    }

    .job-action {
      margin-block: var(--size-3) 0;
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
      max-inline-size: 100%;
      line-height: var(--font-lineheight-5);

      position: relative;
      z-index: 1;

      span {
        flex: 1;
        overflow: hidden;
        text-wrap: nowrap;
        text-overflow: ellipsis;
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
      border-block-end: var(--size-px) solid var(--accent-1);
      block-size: var(--size-16);
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
