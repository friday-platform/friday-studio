<script lang="ts">
  import { PageLayout } from "@atlas/ui";
  import { getClient } from "$lib/client.ts";

  interface DiscoverItem {
    slug: string;
    name: string;
    description: string;
    hasWorkspaceYml: boolean;
  }

  const SKELETON_COUNT = 9;
  const SKELETON_SPACES = Array.from({ length: SKELETON_COUNT }, (_, i) => i + 1);

  let items = $state<DiscoverItem[]>([]);
  let loading = $state(true);
  let errorMsg = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    errorMsg = null;
    try {
      const res = await getClient().api.discover.list.$get();
      if (!res.ok) {
        errorMsg = `Failed to load (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      if ("error" in data && typeof data.error === "string") {
        errorMsg = data.error;
        return;
      }
      if ("items" in data && Array.isArray(data.items)) {
        items = data.items as DiscoverItem[];
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });
</script>

<PageLayout.Root>
  <PageLayout.Title subtitle="Explore how others are using Friday">
    Discover Spaces
  </PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      {#if errorMsg}
        <div class="error-banner" role="alert">
          <span>{errorMsg}</span>
          <button class="retry" onclick={() => void load()}>Retry</button>
        </div>
      {/if}

      <div class="space-grid">
        {#if loading}
          {#each SKELETON_SPACES as space (space)}
            <div class="space-card skeleton-shimmer">
              <div class="card-header">
                <div class="card-dot"></div>
                <div class="card-badge"></div>
              </div>
              <div class="card-title-line"></div>
              <div class="card-sub-line" style="inline-size: 80%"></div>
              <div class="card-sub-line" style="inline-size: 60%"></div>
            </div>
          {/each}
        {:else}
          {#each items as item (item.slug)}
            <a class="space-card" href={`/discover/${item.slug}`}>
              <div class="card-header">
                <div class="card-dot"></div>
              </div>
              <h3 class="card-title">{item.name}</h3>
              {#if item.description}
                <p class="card-desc">{item.description}</p>
              {:else}
                <p class="card-desc muted">{item.slug}</p>
              {/if}
            </a>
          {/each}
          {#if items.length === 0 && !errorMsg}
            <div class="empty">No workspaces found in this repo path.</div>
          {/if}
        {/if}
      </div>
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 50%);
    border-radius: 6px;
    display: flex;
    gap: 12px;
    padding: 10px 14px;
  }

  .retry {
    background: transparent;
    border: 1px solid var(--color-border-2);
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    margin-left: auto;
    padding: 3px 10px;
  }

  .space-grid {
    display: grid;
    gap: var(--size-4);
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }

  .space-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-5);
    text-decoration: none;
    transition:
      border-color 120ms ease,
      transform 120ms ease;
  }

  a.space-card:hover {
    border-color: var(--color-border-2);
    transform: translateY(-1px);
  }

  .card-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    min-block-size: var(--size-4);
  }

  .card-dot {
    background: color-mix(in srgb, var(--color-accent, #1171df), transparent 50%);
    block-size: 10px;
    border-radius: 50%;
    inline-size: 10px;
  }

  .card-badge {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-round);
    block-size: var(--size-4);
    inline-size: 64px;
  }

  .card-title {
    color: var(--color-text);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.005em;
    margin: 0;
  }

  .card-desc {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
  }

  .card-desc.muted {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
  }

  .card-title-line {
    background: color-mix(in srgb, var(--color-text), transparent 82%);
    block-size: var(--size-4);
    border-radius: var(--radius-2);
    inline-size: 75%;
  }

  .card-sub-line {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    block-size: var(--size-2-5);
    border-radius: var(--radius-2);
  }

  @keyframes shimmer {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
    100% {
      opacity: 1;
    }
  }

  .skeleton-shimmer {
    animation: shimmer 2s ease-in-out infinite;
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: 13px;
    grid-column: 1 / -1;
    padding: var(--size-6);
    text-align: center;
  }
</style>
