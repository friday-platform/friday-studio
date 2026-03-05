<script lang="ts">
  /**
   * Action trace panel for FSM execution.
   *
   * Shows an expandable list of actions grouped by state, displaying
   * action type, status, and input details. Uses Collapsible for
   * expandable sections, following the pattern from trace-panel.svelte.
   *
   * @component
   * @param {ActionEntry[]} actions - actionTrace from ExecutionReport
   * @param {number} stepIndex - current stepper position (-1 = all actions visible)
   * @param {string[]} stateOrder - ordered state names from stateTransitions
   */
  import { Collapsible, IconSmall } from "@atlas/ui";

  type ActionEntry = {
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  };

  type Props = { actions: ActionEntry[]; stepIndex: number; stateOrder: string[] };

  let { actions, stepIndex, stateOrder }: Props = $props();

  /** States visible up to (and including) the current step. */
  const visibleStates = $derived.by(() => {
    if (stepIndex < 0) return new Set<string>();
    const states = new Set<string>();
    for (let i = 0; i <= stepIndex && i < stateOrder.length; i++) {
      states.add(stateOrder[i]);
    }
    return states;
  });

  /** Actions filtered to visible states. */
  const visibleActions = $derived(
    stepIndex < 0 ? [] : actions.filter((a) => visibleStates.has(a.state)),
  );

  /** Group visible actions by state. */
  const groupedByState = $derived.by(() => {
    const groups: Array<{ state: string; actions: ActionEntry[] }> = [];
    const map = new Map<string, ActionEntry[]>();

    for (const action of visibleActions) {
      let group = map.get(action.state);
      if (!group) {
        group = [];
        map.set(action.state, group);
        groups.push({ state: action.state, actions: group });
      }
      group.push(action);
    }

    return groups;
  });

  const hasActions = $derived(visibleActions.length > 0);

  /** Status indicator color. */
  function statusColor(status: ActionEntry["status"]): string {
    switch (status) {
      case "completed":
        return "#22c55e";
      case "failed":
        return "var(--color-error)";
      case "started":
        return "#f59e0b";
    }
  }

  /** Truncate a string for display. */
  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + "..." : s;
  }
</script>

<div class="action-trace-panel">
  {#if !hasActions}
    <div class="empty">
      {#if stepIndex < 0}
        Step through execution to see action traces.
      {:else}
        No actions at this step.
      {/if}
    </div>
  {:else}
    <div class="state-groups">
      {#each groupedByState as group (group.state)}
        <div class="state-group">
          <div class="state-header">{group.state}</div>
          <div class="action-list">
            {#each group.actions as action, i (`${action.state}-${action.actionType}-${i}`)}
              <div class="action-entry">
                <Collapsible.Root>
                  <Collapsible.Trigger size="grow">
                    {#snippet children(open)}
                      <span class="action-header">
                        <span class="action-chevron" class:expanded={open}>
                          <IconSmall.CaretRight />
                        </span>
                        <span
                          class="action-status-dot"
                          style:background-color={statusColor(action.status)}
                        ></span>
                        <span class="action-type">{action.actionType}</span>
                        {#if action.actionId}
                          <span class="action-id">{action.actionId}</span>
                        {/if}
                        <span class="action-status">{action.status}</span>
                      </span>
                    {/snippet}
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div class="action-details">
                      <div class="detail-row">
                        <span class="detail-label">Type</span>
                        <span class="detail-value">{action.actionType}</span>
                      </div>
                      <div class="detail-row">
                        <span class="detail-label">Status</span>
                        <span class="detail-value" style:color={statusColor(action.status)}>
                          {action.status}
                        </span>
                      </div>
                      {#if action.actionId}
                        <div class="detail-row">
                          <span class="detail-label">ID</span>
                          <span class="detail-value">{action.actionId}</span>
                        </div>
                      {/if}
                      {#if action.input?.task}
                        <div class="detail-row">
                          <span class="detail-label">Task</span>
                          <span class="detail-value">{truncate(action.input.task, 200)}</span>
                        </div>
                      {/if}
                      {#if action.input?.config}
                        <div class="detail-col">
                          <span class="detail-label">Config</span>
                          <pre class="detail-pre">{JSON.stringify(
                              action.input.config,
                              null,
                              2,
                            )}</pre>
                        </div>
                      {/if}
                      {#if action.error}
                        <div class="detail-col">
                          <span class="detail-label">Error</span>
                          <pre class="detail-pre detail-error">{action.error}</pre>
                        </div>
                      {/if}
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .action-chevron {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: inline-flex;
    transition: transform 0.15s ease;
  }

  .action-chevron :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .action-details {
    border-block-start: 1px solid var(--color-border-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding-block: var(--size-2);
    padding-inline: var(--size-6);
  }

  .action-entry {
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-1);
    overflow: hidden;
  }

  .action-entry :global(button) {
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2);
    transition: background-color 0.1s;
  }

  .action-entry :global(button:hover) {
    background-color: var(--color-highlight-1);
  }

  .action-header {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    inline-size: 100%;
    text-align: start;
  }

  .action-id {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .action-status {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    margin-inline-start: auto;
  }

  .action-status-dot {
    block-size: 6px;
    border-radius: var(--radius-round);
    flex-shrink: 0;
    inline-size: 6px;
  }

  .action-trace-panel {
    display: flex;
    flex-direction: column;
  }

  .action-type {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-family-monospace);
    font-weight: var(--font-weight-5);
  }

  .detail-col {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .detail-error {
    color: var(--color-error);
  }

  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    inline-size: 100px;
  }

  .detail-pre {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    max-block-size: 150px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-row {
    display: flex;
    gap: var(--size-2);
  }

  .detail-value {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding-block: var(--size-4);
  }

  .expanded {
    transform: rotate(90deg);
  }

  .state-groups {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .state-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .state-header {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }
</style>
