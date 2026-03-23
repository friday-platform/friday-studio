<!--
  Single row within the jobs dashboard card.

  Two-line layout: job title + actions on top, description underneath.

  @component
  @param {string} workspaceId - Active workspace ID
  @param {{ id: string; title: string; description: string | null; triggers: { signal: string }[] }} job - Job summary
  @param {Record<string, { description: string; title?: string; schema?: Record<string, unknown> }>} signals - Workspace signals keyed by ID
-->
<script lang="ts">
  import { DropdownMenu } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import RunJobDialog from "$lib/components/run-job-dialog.svelte";
  import { DAEMON_BASE_URL } from "$lib/daemon-url";

  type Job = {
    id: string;
    title: string;
    description: string | null;
    triggers: { signal: string }[];
  };

  type Props = {
    workspaceId: string;
    job: Job;
    signals: Record<string, { description: string; title?: string; schema?: Record<string, unknown> }>;
  };

  let { workspaceId, job, signals }: Props = $props();

  /** Build a placeholder JSON body from a signal's schema properties. */
  function buildBodyFromSchema(schema: Record<string, unknown> | undefined): string {
    if (!schema) return "{}";
    const props = schema.properties;
    if (typeof props !== "object" || props === null) return "{}";

    const entries: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props as Record<string, Record<string, unknown>>)) {
      const t = typeof def === "object" && def !== null ? def.type : undefined;
      if (t === "number" || t === "integer") entries[key] = 0;
      else if (t === "boolean") entries[key] = false;
      else if (t === "array") entries[key] = [];
      else if (t === "object") entries[key] = {};
      else entries[key] = "";
    }
    return "{ " + Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + " }";
  }

  function handleMenuAction(action: string) {
    if (action === "copy-curl") {
      const trigger = job.triggers[0];
      if (trigger) {
        const signal = signals[trigger.signal];
        const body = buildBodyFromSchema(signal?.schema);
        const escaped = body.replace(/'/g, "'\\''");
        const curl = [
          "curl -X POST",
          `-H 'Content-Type: application/json'`,
          `-d '${escaped}'`,
          `${DAEMON_BASE_URL}/api/workspaces/${workspaceId}/signals/${trigger.signal}`,
        ].join(" \\\n  ");
        navigator.clipboard.writeText(curl);
      }
    } else if (action === "copy-cli") {
      const trigger = job.triggers[0];
      const signalName = trigger?.signal ?? job.id;
      const signal = trigger ? signals[trigger.signal] : undefined;
      const body = buildBodyFromSchema(signal?.schema);
      const escaped = body.replace(/'/g, "'\\''");
      const cmd = `deno task atlas signal trigger ${signalName} --workspace ${workspaceId} --data '${escaped}'`;
      navigator.clipboard.writeText(cmd);
    }
  }
</script>

<div class="job-row">
  <div class="job-top">
    <span class="job-name">{job.title}</span>

    <div class="job-actions">
      <DropdownMenu.Root
        positioning={{ placement: "bottom-end" }}
      >
        {#snippet children()}
          <DropdownMenu.Trigger class="overflow-trigger" aria-label="Job options">
            <span class="overflow-btn">&hellip;</span>
          </DropdownMenu.Trigger>

          <DropdownMenu.Content>
            <DropdownMenu.Item onclick={() => goto(`/platform/${workspaceId}/jobs`)}>
              View job
            </DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => handleMenuAction("copy-curl")}>
              Copy as cURL
            </DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => handleMenuAction("copy-cli")}>
              Copy CLI command
            </DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => goto(`/platform/${workspaceId}/edit?path=jobs.${job.id}`)}>
              Edit configuration
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        {/snippet}
      </DropdownMenu.Root>

      <RunJobDialog
        {workspaceId}
        jobId={job.id}
        jobTitle={job.title}
        {signals}
        triggers={job.triggers}
      />
    </div>
  </div>

  {#if job.description}
    <p class="job-description">{job.description}</p>
  {/if}
</div>

<style>
  .job-row {
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block-end: var(--size-2);
    position: relative;
    transition: background-color 100ms ease;
  }

  .job-top {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .job-name {
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-description {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
  }

  .job-actions :global(.overflow-trigger) {
    border-radius: var(--radius-2);
  }

  .overflow-btn {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    line-height: 1;
    padding: var(--size-1) var(--size-2);
  }

  :global(.overflow-trigger):hover .overflow-btn {
    background: var(--color-surface-2);
    color: var(--color-text);
  }
</style>
