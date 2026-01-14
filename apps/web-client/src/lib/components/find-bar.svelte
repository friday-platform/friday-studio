<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";

  type Props = { open: boolean; onClose: () => void };

  let { open = $bindable(), onClose }: Props = $props();

  let searchText = $state("");
  let inputElement: HTMLInputElement | null = $state(null);
  let matchInfo = $state("");
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentMatchIndex = $state(0);
  let totalMatches = $state(0);

  // Focus input when opened
  $effect(() => {
    if (open && inputElement) {
      requestAnimationFrame(() => {
        inputElement?.focus();
      });
    }
  });

  // Clear highlights when closed
  $effect(() => {
    if (!open) {
      clearHighlights();
      searchText = "";
      matchInfo = "";
      currentMatchIndex = 0;
      totalMatches = 0;
    }
  });

  function clearHighlights() {
    // Remove all highlight marks
    const marks = document.querySelectorAll("mark.find-highlight");
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    }
  }

  function highlightMatches(text: string): number {
    clearHighlights();

    if (!text) return 0;

    const searchLower = text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip script, style, and our find bar
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tagName = parent.tagName.toLowerCase();
        if (tagName === "script" || tagName === "style" || tagName === "mark") {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(".find-bar")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.textContent?.toLowerCase().includes(searchLower)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    });

    const nodesToHighlight: { node: Text; indices: number[] }[] = [];

    let currentNode = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode as Text;
      const content = textNode.textContent || "";
      const contentLower = content.toLowerCase();
      const indices: number[] = [];

      let idx = contentLower.indexOf(searchLower);
      while (idx !== -1) {
        indices.push(idx);
        idx = contentLower.indexOf(searchLower, idx + 1);
      }

      if (indices.length > 0) {
        nodesToHighlight.push({ node: textNode, indices });
      }

      currentNode = walker.nextNode();
    }

    let count = 0;
    for (const { node, indices } of nodesToHighlight) {
      const content = node.textContent || "";
      const fragment = document.createDocumentFragment();
      let lastIdx = 0;

      for (const idx of indices) {
        if (idx > lastIdx) {
          fragment.appendChild(document.createTextNode(content.slice(lastIdx, idx)));
        }
        const mark = document.createElement("mark");
        mark.className = "find-highlight";
        mark.textContent = content.slice(idx, idx + text.length);
        fragment.appendChild(mark);
        lastIdx = idx + text.length;
        count++;
      }

      if (lastIdx < content.length) {
        fragment.appendChild(document.createTextNode(content.slice(lastIdx)));
      }

      node.parentNode?.replaceChild(fragment, node);
    }

    return count;
  }

  function scrollToMatch(index: number) {
    const marks = document.querySelectorAll("mark.find-highlight");
    if (marks.length === 0) return;

    // Remove current highlight from all
    for (const mark of marks) {
      mark.classList.remove("current");
    }

    // Wrap index
    const wrappedIndex = ((index % marks.length) + marks.length) % marks.length;
    currentMatchIndex = wrappedIndex;

    const currentMark = marks[wrappedIndex] as HTMLElement;
    if (currentMark) {
      currentMark.classList.add("current");

      // Small delay to ensure the class is applied before scrolling
      requestAnimationFrame(() => {
        currentMark.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      });
    }
  }

  function performSearch() {
    if (!searchText.trim()) {
      clearHighlights();
      matchInfo = "";
      totalMatches = 0;
      currentMatchIndex = 0;
      return;
    }

    const count = highlightMatches(searchText);
    totalMatches = count;

    if (count > 0) {
      currentMatchIndex = 0;
      scrollToMatch(0);
      matchInfo = `1 of ${count}`;
    } else {
      matchInfo = "No matches";
    }
  }

  function findNext() {
    if (totalMatches === 0) return;
    const nextIndex = currentMatchIndex + 1;
    scrollToMatch(nextIndex);
    matchInfo = `${currentMatchIndex + 1} of ${totalMatches}`;
  }

  function findPrevious() {
    if (totalMatches === 0) return;
    const prevIndex = currentMatchIndex - 1;
    scrollToMatch(prevIndex);
    matchInfo = `${currentMatchIndex + 1} of ${totalMatches}`;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "g" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  }

  function handleInput() {
    // Debounce search to avoid performance issues
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    searchTimeout = setTimeout(() => {
      performSearch();
    }, 150);
  }

  function close() {
    open = false;
    onClose();
  }
</script>

{#if open}
  <div class="find-bar" role="search">
    <div class="find-container">
      <input
        bind:this={inputElement}
        bind:value={searchText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        type="text"
        placeholder="Find in page..."
        spellcheck="false"
        autocomplete="off"
      />
      {#if matchInfo}
        <span class="match-info">{matchInfo}</span>
      {/if}
      <div class="buttons">
        <button
          type="button"
          onclick={findPrevious}
          title="Previous (Shift+Enter)"
          disabled={!searchText}
        >
          <IconSmall.CaretUp />
        </button>
        <button type="button" onclick={findNext} title="Next (Enter)" disabled={!searchText}>
          <IconSmall.CaretDown />
        </button>
        <button type="button" onclick={close} title="Close (Escape)" class="close-btn">
          <IconSmall.Close />
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .find-bar {
    inset-block-start: var(--size-14);
    inset-inline-end: var(--size-4);
    pointer-events: auto;
    position: fixed;
    z-index: 9999;
  }

  .find-container {
    align-items: center;
    background-color: var(--color-surface-1);
    border-radius: var(--radius-3);
    box-shadow: var(--shadow-1);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
  }

  input {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-size: var(--font-size-3);
    inline-size: var(--size-64);
    padding: var(--size-1-5) var(--size-2);
    outline: none;

    &:focus {
      border-color: var(--color-yellow);
    }

    &::placeholder {
      color: color-mix(in srgb, var(--color-text) 50%, transparent);
    }
  }

  .match-info {
    color: color-mix(in srgb, var(--color-text) 50%, transparent);
    font-size: var(--font-size-2, 12px);
    min-inline-size: var(--size-16);
    white-space: nowrap;
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: var(--size-1);
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    block-size: var(--size-7);
    inline-size: var(--size-7);
    transition: all 0.15s;

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 10%);
    }

    &:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
  }

  .close-btn {
    margin-inline-start: var(--size-1);
  }

  /* Global styles for highlights - using :global to affect elements outside this component */
  :global(mark.find-highlight) {
    background-color: rgba(255, 213, 0, 0.4);
    border-radius: var(--radius-1);
    color: inherit;
    padding: 0 1px;
  }

  :global(mark.find-highlight.current) {
    background-color: rgba(255, 166, 0, 0.8);
  }
</style>
