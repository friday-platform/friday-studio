<script lang="ts">
  import type { ScheduleProposal } from "./types";

  interface Props {
    proposal: ScheduleProposal;
    onconfirm: (proposal: ScheduleProposal) => void;
    oncancel: () => void;
  }

  const { proposal, onconfirm, oncancel }: Props = $props();

  let editing = $state(false);
  let editTaskBrief = $state(proposal.taskBrief);
  let editPriority = $state(proposal.priority);
  let editKind: "feature" | "improvement" | "bugfix" = $state(proposal.kind);

  function handleConfirm() {
    if (editing) {
      onconfirm({
        ...proposal,
        taskBrief: editTaskBrief,
        priority: editPriority,
        kind: editKind,
      });
    } else {
      onconfirm(proposal);
    }
  }

  function handleEdit() {
    editing = true;
  }

  function handleCancelEdit() {
    editing = false;
    editTaskBrief = proposal.taskBrief;
    editPriority = proposal.priority;
    editKind = proposal.kind;
  }
</script>

<div class="proposal-card">
  <div class="proposal-header">
    <span class="proposal-label">FAST Task Proposal</span>
    <span class="proposal-kind">{editing ? editKind : proposal.kind}</span>
  </div>

  <div class="proposal-id">{proposal.taskId}</div>
  <div class="proposal-text">{proposal.text}</div>

  {#if editing}
    <div class="edit-form">
      <label class="edit-label">
        Brief:
        <textarea class="edit-textarea" bind:value={editTaskBrief} rows="3"></textarea>
      </label>
      <div class="edit-row">
        <label class="edit-label">
          Priority (5-20):
          <input class="edit-input" type="number" min="5" max="20" bind:value={editPriority} />
        </label>
        <label class="edit-label">
          Kind:
          <select class="edit-select" bind:value={editKind}>
            <option value="feature">feature</option>
            <option value="improvement">improvement</option>
            <option value="bugfix">bugfix</option>
          </select>
        </label>
      </div>
    </div>
  {:else}
    <div class="proposal-brief">{proposal.taskBrief}</div>
    <div class="proposal-priority">Priority: {proposal.priority}</div>
  {/if}

  <div class="proposal-actions">
    {#if editing}
      <button class="btn btn-confirm" onclick={handleConfirm}>Schedule</button>
      <button class="btn btn-cancel" onclick={handleCancelEdit}>Back</button>
    {:else}
      <button class="btn btn-confirm" onclick={handleConfirm}>Confirm</button>
      <button class="btn btn-edit" onclick={handleEdit}>Edit</button>
      <button class="btn btn-cancel" onclick={oncancel}>Cancel</button>
    {/if}
  </div>
</div>

<style>
  .proposal-card {
    background-color: color-mix(in srgb, var(--color-warning, #f59e0b), transparent 88%);
    border: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .proposal-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .proposal-label {
    color: var(--color-warning, #f59e0b);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .proposal-kind {
    background-color: color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-2);
    font-size: var(--font-size-0);
    padding: var(--size-0-5) var(--size-1-5);
    text-transform: uppercase;
  }

  .proposal-id {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: monospace;
    font-size: var(--font-size-0);
  }

  .proposal-text {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .proposal-brief {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .proposal-priority {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
  }

  .proposal-actions {
    display: flex;
    gap: var(--size-2);
    margin-block-start: var(--size-1);
  }

  .btn {
    border: 1px solid transparent;
    border-radius: var(--radius-2);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-2-5);
    transition: background-color 150ms ease;
  }

  .btn-confirm {
    background-color: var(--color-success, #22c55e);
    color: white;
  }

  .btn-confirm:hover {
    background-color: color-mix(in srgb, var(--color-success, #22c55e), black 15%);
  }

  .btn-edit {
    background-color: var(--color-surface-3);
    border-color: var(--color-border-1);
    color: var(--color-text);
  }

  .btn-edit:hover {
    background-color: var(--color-surface-2);
  }

  .btn-cancel {
    background-color: transparent;
    border-color: var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .btn-cancel:hover {
    background-color: color-mix(in srgb, var(--color-error, #ef4444), transparent 90%);
  }

  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .edit-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-1);
    gap: var(--size-1);
  }

  .edit-textarea {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-1);
    padding: var(--size-1-5);
    resize: vertical;
  }

  .edit-row {
    display: flex;
    gap: var(--size-3);
  }

  .edit-input,
  .edit-select {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-1);
    padding: var(--size-1);
  }

  .edit-input {
    inline-size: 80px;
  }
</style>
