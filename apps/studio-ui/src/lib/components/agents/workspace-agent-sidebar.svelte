<!--
  Read-only detail sidebar for workspace-level agents.

  Shows the agent's name, type, description, prompt, and environment
  variable names. This is distinct from the FSM agent editor sidebar —
  it displays workspace-level config rather than job-specific task prompts.

  @component
  @param {import("@atlas/config/mutations").WorkspaceAgent} agent - Workspace agent to display
-->

<script lang="ts">
  import type { AgentStepRef } from "@atlas/config/agent-job-usage";
  import type { WorkspaceAgent } from "@atlas/config/workspace-agents";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";

  type Props = {
    agent: WorkspaceAgent;
    usedIn?: AgentStepRef[];
    onStepClick?: (jobId: string, stepId: string) => void;
  };

  let { agent, usedIn = [], onStepClick }: Props = $props();

  const envKeys = $derived(Object.keys(agent.env));

  /** Group usage refs by jobId for multi-job display. */
  const usageByJob = $derived.by(() => {
    const groups = new Map<string, AgentStepRef[]>();
    for (const ref of usedIn) {
      const existing = groups.get(ref.jobId);
      if (existing) {
        existing.push(ref);
      } else {
        groups.set(ref.jobId, [ref]);
      }
    }
    return groups;
  });

  const isSingleJob = $derived(usageByJob.size <= 1);
</script>

<div class="workspace-agent-sidebar">
  <div class="section">
    <h3 class="section-title">Workspace Agent</h3>
    <p class="agent-name">
      {agent.name}
      <InlineBadge variant="success">{agent.agent ?? agent.type}</InlineBadge>
    </p>
  </div>

  {#if agent.description}
    <div class="section">
      <h4 class="field-label">Description</h4>
      <p class="description">{agent.description}</p>
    </div>
  {/if}

  {#if agent.prompt}
    <div class="section">
      <h4 class="field-label">Prompt</h4>
      <pre class="prompt-block">{agent.prompt}</pre>
    </div>
  {/if}

  {#if envKeys.length > 0}
    <div class="section">
      <h4 class="field-label">Environment Variables</h4>
      <ul class="env-list">
        {#each envKeys as key (key)}
          <li class="env-item">{key}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="section">
    <h4 class="field-label">Used In</h4>
    {#if usedIn.length === 0}
      <p class="empty-message">Not used in any pipeline step</p>
    {:else if isSingleJob}
      <ul class="usage-list">
        {#each usedIn as ref (ref.jobId + ":" + ref.stepId)}
          <li>
            <button class="usage-link" onclick={() => onStepClick?.(ref.jobId, ref.stepId)}>
              {ref.stepName}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      {#each [...usageByJob.entries()] as [jobId, refs] (jobId)}
        <div class="usage-group">
          <span class="usage-job-label">{jobId}</span>
          <ul class="usage-list">
            {#each refs as ref (ref.stepId)}
              <li>
                <button class="usage-link" onclick={() => onStepClick?.(ref.jobId, ref.stepId)}>
                  {ref.stepName}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .workspace-agent-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-title {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .agent-name {
    align-items: center;
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    gap: var(--size-2);
    word-break: break-all;
  }

  .field-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .prompt-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: 1.6;
    max-block-size: 300px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .env-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .env-item {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  /* ---- Used In section ---- */

  .empty-message {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  .usage-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .usage-link {
    background: none;
    border: none;
    color: var(--color-info);
    cursor: pointer;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
    text-align: start;
    width: 100%;
  }

  .usage-link:hover {
    background-color: color-mix(in srgb, var(--color-info), transparent 90%);
    border-radius: var(--radius-1);
  }

  .usage-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .usage-job-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }
</style>
