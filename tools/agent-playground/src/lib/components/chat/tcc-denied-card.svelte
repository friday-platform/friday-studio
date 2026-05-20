<script lang="ts">
  import { Button, IconSmall } from "@atlas/ui";

  interface TccAction {
    label: string;
    type: "open-url" | "copy-shell";
    payload: string;
  }

  interface TccDenied {
    kind: "tcc-denied";
    protectedRoot: string;
    attemptedPath: string;
    guidance: string;
    actions: TccAction[];
  }

  interface Props {
    denial: TccDenied;
  }

  const { denial }: Props = $props();

  let copied = $state<string | null>(null);

  function handleAction(action: TccAction) {
    if (action.type === "open-url") {
      // Use location.href so the OS handler claims the x-apple… deeplink.
      // window.open() in some browsers blocks unknown schemes silently.
      window.location.href = action.payload;
      return;
    }
    void navigator.clipboard.writeText(action.payload).then(() => {
      copied = action.payload;
      setTimeout(() => {
        if (copied === action.payload) copied = null;
      }, 1800);
    });
  }
</script>

<div class="tcc-card" role="region" aria-label="macOS permission needed">
  <div class="header">
    <span class="icon" aria-hidden="true"><IconSmall.Clock /></span>
    <span class="eyebrow">macOS permission needed</span>
  </div>

  <p class="guidance">{denial.guidance}</p>

  <code class="path" title={denial.attemptedPath}>{denial.attemptedPath}</code>

  <div class="actions">
    {#each denial.actions as action (action.label + action.payload)}
      <Button onclick={() => handleAction(action)}>
        {copied === action.payload ? "Copied!" : action.label}
      </Button>
    {/each}
  </div>
</div>

<style>
  .tcc-card {
    background-color: color-mix(in srgb, var(--yellow-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--yellow-primary), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .icon {
    color: color-mix(in srgb, var(--yellow-primary), black 25%);
    display: inline-flex;
  }

  .eyebrow {
    color: color-mix(in srgb, var(--text), transparent 30%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-7);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .guidance {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    line-height: 1.4;
    margin: 0;
  }

  .path {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    padding: var(--size-1) var(--size-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }
</style>
