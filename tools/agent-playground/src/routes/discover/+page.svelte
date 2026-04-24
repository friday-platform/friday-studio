<script lang="ts">
  import { IconLarge } from "@atlas/ui";

  const CATEGORIES = ["All", "Finance", "DevOps", "Research", "Productivity", "Marketing"];

  let activeCategory = $state("All");

  const SKELETON_COUNT = 9;
  const SKELETON_SPACES = Array.from({ length: SKELETON_COUNT }, (_, i) => i + 1);

  const visible = $derived(SKELETON_SPACES);
</script>

<div class="discover-root">
  <header class="page-header">
    <div class="header-icon">
      <IconLarge.Compass />
    </div>
    <div class="header-text">
      <h1>Discover Spaces</h1>
      <p class="subtitle">Explore how others are using Friday, then build your own.</p>
    </div>
  </header>

  <div class="filter-bar">
    {#each CATEGORIES as cat (cat)}
      <button
        class="filter-btn"
        class:active={activeCategory === cat}
        onclick={() => (activeCategory = cat)}
      >
        {cat}
      </button>
    {/each}
  </div>

  <div class="space-grid">
    {#each visible as space (space)}
      <div class="space-card skeleton-shimmer">
        <div class="card-header">
          <div class="card-dot"></div>
          <div class="card-badge"></div>
        </div>
        <div class="card-title-line"></div>
        <div class="card-sub-line" style="inline-size: 80%"></div>
        <div class="card-sub-line" style="inline-size: 60%"></div>
        <div class="card-meta">
          <div class="card-meta-line" style="inline-size: 40%"></div>
          <div class="card-action"></div>
        </div>
      </div>
    {/each}
  </div>

  <div class="coming-soon">
    <p>Space catalog coming soon. <a href="/platform">Build your own space</a> in the meantime.</p>
  </div>
</div>

<style>
  .discover-root {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    max-inline-size: 900px;
    margin-inline: auto;
    padding: var(--size-10) var(--size-6);
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: var(--size-4);
  }

  .header-icon {
    color: var(--color-accent, #1171df);
    flex-shrink: 0;
    opacity: 0.8;
  }

  .header-text {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .page-header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
  }

  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .filter-btn {
    all: unset;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-3);
    transition: all 120ms ease;

    &:hover {
      background: var(--color-surface-3);
      color: var(--color-text);
    }

    &.active {
      background: color-mix(in srgb, var(--color-accent, #1171df), transparent 85%);
      border-color: color-mix(in srgb, var(--color-accent, #1171df), transparent 50%);
      color: var(--color-accent, #1171df);
    }
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
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-5);
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .card-dot {
    background: color-mix(in srgb, var(--color-text), transparent 80%);
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

  .card-meta {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-block-start: var(--size-1);
  }

  .card-meta-line {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    block-size: var(--size-2);
    border-radius: var(--radius-2);
  }

  .card-action {
    background: color-mix(in srgb, var(--color-accent, #1171df), transparent 80%);
    block-size: var(--size-6);
    border-radius: var(--radius-2);
    inline-size: 64px;
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

  .coming-soon {
    padding-block: var(--size-4);
    text-align: center;
  }

  .coming-soon p {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-2);
  }

  .coming-soon a {
    color: var(--color-accent, #1171df);
    text-decoration: underline;
  }
</style>
