<script lang="ts">
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import Button from "$lib/components/button.svelte";
  import Dot from "$lib/components/dot.svelte";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import RunJobDialog from "../../(components)/run-job-dialog.svelte";
  import AgentDetails from "./(components)/agent-details.svelte";
  import SignalDetails from "./(components)/signal-details.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const appCtx = getAppContext();

  const job = $derived(data.job);
  const signals = $derived(job?.signals ? Object.entries(job.signals) : []);

  const jobConfig = $derived(data.workspace.config?.jobs?.[data.jobId]);

  // FSM agents have jobId; filter to that shape
  const agents = $derived(
    (job?.agents ?? []).filter(
      (a): a is Extract<(typeof job.agents)[number], { jobId: string }> => "jobId" in a,
    ),
  );
</script>

<Breadcrumbs.Root fixed>
  <Breadcrumbs.Item href={appCtx.routes.spaces.item(data.spaceId)} showCaret>
    {#snippet prepend()}
      <Dot color={data.workspace.metadata?.color} />
    {/snippet}
    {data.workspace.name}
  </Breadcrumbs.Item>
</Breadcrumbs.Root>

<div class="wrapper">
  <article class="page">
    <div>
      <header>
        <h1>{job.name}</h1>

        <div class="integrations">
          {#each job.integrations as integration (integration)}
            {@const icon = getServiceIcon(integration)}
            <div class="integration">
              {#if icon}
                {#if icon.type === "component"}
                  {@const Component = icon.src}
                  <Component />
                {:else}
                  <img src={icon.src} alt={`${integration} logo`} />
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      </header>

      {#if job.description}
        <p class="description">{job.description}</p>
      {/if}

      {#if jobConfig}
        <div class="run-job">
          <RunJobDialog
            jobId={data.jobId}
            job={jobConfig}
            signals={data.workspace.config?.signals ?? {}}
            workspaceId={data.spaceId}
          >
            {#snippet triggerContents()}
              <Button size="small">Run</Button>
            {/snippet}
          </RunJobDialog>
        </div>
      {/if}
    </div>

    {#if signals.length > 0}
      <section class="section">
        <h2>Signals</h2>
        {#each signals as [id, signal] (id)}
          <SignalDetails {signal} workspaceId={data.spaceId} signalId={id} />
        {/each}
      </section>
    {/if}

    {#if agents.length > 0}
      <section class="section">
        <h2>Agents</h2>
        <AgentDetails {agents} integrations={data.integrations} workspaceId={data.spaceId} />
      </section>
    {/if}
  </article>
</div>

<style>
  .wrapper {
    padding: var(--size-14);
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: var(--size-12);
    margin-inline: auto;
    max-inline-size: var(--size-160);
  }

  header {
    align-items: center;
    display: flex;
    gap: var(--size-3);

    h1 {
      font-size: var(--font-size-8);
      font-weight: var(--font-weight-6);
    }

    .integrations {
      display: flex;
      flex-wrap: wrap;
      gap: var(--size-1);
    }
  }

  .description {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-3);
    max-inline-size: 80ch;
    opacity: 0.6;
  }

  .run-job {
    margin-block-start: var(--size-4);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);

    h2 {
      font-size: var(--font-size-6);
      font-weight: var(--font-weight-6);
    }
  }

  .integration {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }
</style>
