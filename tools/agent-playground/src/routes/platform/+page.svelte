<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import WorkspaceLoader from "$lib/components/workspace/workspace-loader.svelte";
  import { workspaceQueries } from "$lib/queries";

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const visibleWorkspaces = $derived(workspacesQuery.data ?? []);

  $effect(() => {
    if (visibleWorkspaces.length > 0 && visibleWorkspaces[0]) {
      goto(`/platform/${visibleWorkspaces[0].id}`, { replaceState: true });
    }
  });
</script>

<div class="empty-state">
  {#if workspacesQuery.isLoading}
    <p class="loading-hint">Loading workspaces...</p>
  {:else if visibleWorkspaces.length === 0}
    <div class="empty-content">
      <pre class="ascii-logo">{`
                   .=*%@@%*=.
                    .=%@@@@@@@@@@%*=.
                     .=%@@@@@@@@@@@@@@@*:
                    .%@@@@@@@@@@@@@@@@@@%:
                    =%@@@@@@@@@@@@@@@@@@@%:
                   :%@@@@@@@@@@@@@@@@@@@@%:
                   +@@@@@@@@@@@@@@@@@@@@%*.
                  +@@@@@@@@@@@@@@@@@@@%*:
                +@@@@@@@@@@@@@@@@@%*:
              +@@@@@@@@@@@@@@@%*:
            .*@@@@@@@@@@@@*=.

        .=*@@@@@@@%*.
   .=%@@@@@@@@@@@@:
  .%@@@@@@@@@@@@@@:
  =%@@@@@@@@@@@@@@:
 .=%@@@@@@@@@@@@@@:
  .=%@@@@@@@@@@@@@:
  .*@@@@@@@@@@@@*.
    .=%@@@@@@%*=.
   .=+*+=.`}</pre>
      <h2 class="empty-title">Friday Agent Studio & Toolkit</h2>
      <p class="empty-description">
        Orchestrate agentic workflows from a single config file. Versionable,
        shareable, repeatable. Drop a workspace.yml to get started.
        <a
          class="learn-more"
          href="https://platform.hellofriday.ai/docs/core-concepts/spaces"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn more
        </a>
      </p>
    </div>
    <WorkspaceLoader inline />
  {/if}
</div>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-6);
    inline-size: 100%;
    justify-content: center;
    max-inline-size: 460px;
    margin-inline: auto;
    min-block-size: 100dvh;
    padding: var(--size-10);
  }

  .empty-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-2);
    max-inline-size: 420px;
    text-align: center;
  }

  .ascii-logo {
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    font-family: monospace;
    font-size: 0.6rem;
    line-height: 1.1;
    margin-block-end: var(--size-4);
    user-select: none;
  }

  .empty-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .empty-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    line-height: var(--line-height-3);
  }

  .learn-more {
    color: var(--color-text);
    opacity: 0.7;
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: opacity 100ms ease;

    &:hover {
      opacity: 1;
    }
  }

  .loading-hint {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
  }
</style>
