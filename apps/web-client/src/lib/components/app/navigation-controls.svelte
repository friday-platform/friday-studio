<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Icons } from "$lib/components/icons";
  import { fade } from "svelte/transition";

  const appCtx = getAppContext();

  let navigationStack = $state<string[]>([]);
  let currentIndex = $state(-1);

  afterNavigate(({ to, type }) => {
    if (!to?.url) return;
    if (type === "popstate") return;

    const currentPath = to.url.pathname;

    // Truncate forward history and add new item
    navigationStack = [...navigationStack.slice(0, currentIndex + 1), currentPath];
    currentIndex = navigationStack.length - 1;
  });

  function goBack() {
    if (currentIndex > 0) {
      currentIndex--;
      window.history.back();
    }
  }

  function goForward() {
    if (currentIndex < navigationStack.length - 1) {
      currentIndex++;
      window.history.forward();
    }
  }

  $effect(() => {
    const keyboard = appCtx.keyboard.state;
    if (!keyboard?.pressing) return;

    const hasCommand = keyboard.modifiers.includes("command");
    if (!hasCommand) return;

    if (keyboard.key === "[") {
      goBack();
    } else if (keyboard.key === "]") {
      goForward();
    }
  });
</script>

<div class="nav-controls" in:fade={{ delay: 150, duration: 150 }}>
  <button
    disabled={currentIndex <= 0}
    onclick={() => {
      goBack();
    }}
  >
    <Icons.ArrowLeft />
  </button>
  <button
    disabled={!(currentIndex < navigationStack.length - 1)}
    onclick={() => {
      goForward();
    }}
  >
    <Icons.ArrowRight />
  </button>
</div>

<style>
  .nav-controls {
    align-items: center;
    gap: var(--size-2);
    display: flex;
    opacity: 0.5;
    position: absolute;
    inset-inline-start: var(--size-40);
    inset-block-start: var(--size-4-5);
    z-index: var(--layer-5);

    button {
      border-radius: var(--size-2);
      align-items: center;
      block-size: var(--size-5);
      display: flex;
      inline-size: var(--size-5);
      justify-content: center;
      transition: all 150ms ease;

      &:focus {
        outline: none;
      }

      &:focus,
      &:hover:not(:disabled) {
        background-color: color-mix(in srgb, var(--color-surface-1) 80%, var(--color-text));
      }

      &:focus-visible {
        outline: var(--size-px) solid var(--color-text);
      }
    }

    button[disabled] {
      opacity: 0.5;
    }
  }
</style>
