<script lang="ts">
import type { Snippet } from "svelte";

let node: HTMLDivElement | null;

type Props = {
  requestLoadItems: () => void;
  hasMoreItems: boolean;
  cursor: unknown;
  isFetching: boolean;
  children: Snippet;
  append?: Snippet;
  offset?: string;
};

let { requestLoadItems, hasMoreItems, cursor, isFetching, children, append, offset }: Props =
  $props();

function onView(entries: IntersectionObserverEntry[]) {
  entries.forEach((entry) => {
    if (!requestLoadItems || !hasMoreItems) return;

    if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
      requestLoadItems();
    }
  });
}

$effect(() => {
  const observer = new IntersectionObserver(onView, { root: null, rootMargin: "0px" });

  // we only want to observe if we are looking to load items and more exist
  // we use the cursor value to trigger an effect change since it changes with
  // each successful requestLoadItems()

  // this is useful so that entries fill up the page until the observable is out of frame
  if (hasMoreItems && cursor && node && !isFetching) {
    observer.observe(node);
  }

  return () => {
    if (node) {
      observer.unobserve(node);
    }
  };
});

// This is an edge case where a user selects the scroll bar and shoots down to the end of the page
// escaping the observer (observers use an asynchronous listener tied to the performance of the brower,
// generally 60fps).
function checkObserverPosition() {
  if (!hasMoreItems || !node) return;

  if (node.getBoundingClientRect().top < 0) {
    requestLoadItems();
  }
}

$effect(() => {
  let timer: ReturnType<typeof setTimeout>;
  const container = document.querySelector("[data-melt-dropdown-menu]");

  if (!container) return;

  container.addEventListener("scroll", () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => checkObserverPosition(), 1000);
  });

  return () => {
    clearTimeout(timer);
  };
});
</script>

{@render children()}

<div class="observer" bind:this={node} style:margin-block-end={offset ?? 0}></div>

{#if append}
	{@render append()}
{/if}

<style>
	.observer {
		/* required to prevent issues when the browser is zoomed in */
		block-size: var(--size-px);
		pointer-events: none;
	}
</style>
