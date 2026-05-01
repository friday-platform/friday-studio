<!--
  Full-width Studio update banner. Mounted as a sibling-above the layout's
  app-shell so it displaces the sidebar+main row. Renders nothing in dev,
  when no update is available, or while a non-expired dismissal is active
  for the current `latest` version.

  @component
-->
<script lang="ts">
  import { bannerDismissed, dismissBanner, updateStatus } from "$lib/update-status.svelte";

  const visible = $derived(
    !updateStatus.isDev &&
      updateStatus.outOfDate &&
      updateStatus.latest !== null &&
      !bannerDismissed.value,
  );
</script>

{#if visible}
  <header class="update-banner" role="banner" aria-live="polite">
    <span class="message">
      A new version of Friday Studio ({updateStatus.latest}) is available.
    </span>
    <a
      class="download"
      href="https://hellofriday.ai/download"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Download Friday Studio update"
    >
      Download →
    </a>
    <button
      class="dismiss"
      type="button"
      onclick={dismissBanner}
      aria-label="Dismiss update notification"
    >
      ✕
    </button>
  </header>
{/if}

<style>
  .update-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-accent, #4f46e5), transparent 80%);
    border-block-end: 1px solid color-mix(in srgb, var(--color-accent, #4f46e5), transparent 60%);
    color: var(--color-text);
    display: flex;
    flex: 0 0 auto;
    font-size: 13px;
    gap: 12px;
    inline-size: 100%;
    padding-block: 8px;
    padding-inline: 16px;
  }

  .message {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .download {
    color: var(--color-text);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .download:hover {
    text-decoration: none;
  }

  .dismiss {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
    padding: 4px 6px;
  }
  .dismiss:hover {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    color: var(--color-text);
  }
</style>
