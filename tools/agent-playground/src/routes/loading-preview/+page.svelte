<script lang="ts">
  import type { Component } from "svelte";
  import DaemonLoading from "$lib/components/shared/daemon-loading.svelte";
  import DaemonLoadingPlain from "$lib/components/shared/daemon-loading-plain.svelte";
  import DaemonLoadingGlide from "$lib/components/shared/daemon-loading-glide.svelte";
  import DaemonLoadingGlideSubtle from "$lib/components/shared/daemon-loading-glide-subtle.svelte";
  import DaemonLoadingDecal from "$lib/components/shared/daemon-loading-decal.svelte";
  import DaemonLoadingWalkLine from "$lib/components/shared/daemon-loading-walk-line.svelte";
  import DaemonLoadingLeapfrogOver from "$lib/components/shared/daemon-loading-leapfrog-over.svelte";
  import DaemonLoadingLeapfrogTight from "$lib/components/shared/daemon-loading-leapfrog-tight.svelte";
  import DaemonLoadingFmarkDance from "$lib/components/shared/daemon-loading-fmark-dance.svelte";

  type Variant = { title: string; component: Component };

  const variants: Variant[] = [
    { title: "Plain (current)", component: DaemonLoadingPlain },
    { title: "Logo bouncy walk", component: DaemonLoading },
    { title: "Bouncy walk + line + shadow", component: DaemonLoadingWalkLine },
    { title: "Leapfrog (over each other)", component: DaemonLoadingLeapfrogOver },
    { title: "Leapfrog (tight)", component: DaemonLoadingLeapfrogTight },
    { title: "F-mark fall + leap dance", component: DaemonLoadingFmarkDance },
    { title: "Logo glide", component: DaemonLoadingGlide },
    { title: "Logo glide (subtle dark)", component: DaemonLoadingGlideSubtle },
    { title: "Decal spinner", component: DaemonLoadingDecal },
  ];

  let previewing = $state<Variant | null>(null);

  function open(v: Variant) {
    previewing = v;
  }
  function close() {
    previewing = null;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="page">
  {#if previewing}
    {@const Comp = previewing.component}
    <div class="preview-bar">
      <button type="button" class="back-btn" onclick={close}>← Back</button>
      <span class="preview-title">{previewing.title}</span>
    </div>
    <div class="preview-stage">
      <Comp />
    </div>
  {:else}
    <h1>Daemon loading variants</h1>
    <div class="grid">
      {#each variants as variant (variant.title)}
        {@const Comp = variant.component}
        <section class="card">
          <header>
            <span>{variant.title}</span>
            <button type="button" class="preview-btn" onclick={() => open(variant)}>
              Preview
            </button>
          </header>
          <div class="stage">
            <Comp />
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: var(--size-6);
    min-block-size: 100%;
    padding: var(--size-8);
  }

  h1 {
    color: var(--text-bright);
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .grid {
    display: grid;
    gap: var(--size-4);
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }

  .card {
    background-color: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    align-items: center;
    border-block-end: 1px solid var(--border);
    color: var(--text-faded);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    justify-content: space-between;
    letter-spacing: 0.04em;
    padding: var(--size-2) var(--size-3);
    text-transform: uppercase;
  }

  .preview-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    padding: var(--size-1) var(--size-2);
    text-transform: uppercase;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .preview-btn:hover {
    background: var(--highlight-bright);
    color: var(--text-bright);
  }

  .stage {
    background-color: var(--surface);
    display: flex;
    min-block-size: var(--size-64);
  }

  /* Preview mode — fills the body, replaces the grid. */
  .preview-bar {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .back-btn {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-1) var(--size-3);
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .back-btn:hover {
    background: var(--highlight-bright);
    color: var(--text-bright);
  }

  .preview-title {
    color: var(--text-faded);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .preview-stage {
    align-items: center;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-5);
    display: flex;
    flex: 1;
    justify-content: center;
    min-block-size: 0;
  }
</style>
