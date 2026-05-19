<!--
  Search input for `<SidebarNav>`. Highlight-tinted pill with a leading
  icon — the catalog filter look from the MCP catalog tree, hoisted so
  every consumer of `<SidebarNav>` shares it.

  Controlled via `bind:value`.

  @component
-->

<script lang="ts">
  import { IconSmall } from "../icons/small/index.js";

  interface Props {
    value?: string;
    placeholder?: string;
    /**
     * Fires on every keystroke (after `bind:value` writes). Use to debounce
     * + sync to a URL param; the consumer owns timing decisions.
     */
    oninput?: (event: Event) => void;
  }

  let { value = $bindable(""), placeholder = "Search", oninput }: Props = $props();
</script>

<div class="search-field">
  <span class="search-icon"><IconSmall.Search /></span>
  <input type="text" {placeholder} bind:value {oninput} autocomplete="off" spellcheck="false" />
</div>

<style>
  .search-field {
    align-items: center;
    background: var(--highlight);
    border-radius: var(--radius-3);
    block-size: var(--size-7-5);
    display: flex;
    gap: var(--size-1-5);
    padding-inline: var(--size-3);
    transition: background-color 120ms ease;
  }

  .search-field:focus-within {
    background: var(--highlight-bright);
  }

  .search-icon {
    color: var(--text-faded);
    display: flex;
    flex-shrink: 0;
  }

  input {
    background: transparent;
    block-size: 100%;
    color: var(--text-bright);
    font-family: inherit;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    inline-size: 100%;
    outline: none;
  }

  input::placeholder {
    color: var(--text-faded);
  }
</style>
