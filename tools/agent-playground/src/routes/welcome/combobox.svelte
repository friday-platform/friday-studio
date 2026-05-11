<!--
  Combobox built on melt-ui's createCombobox. Requires the
  `preprocessMeltUI` preprocessor configured in svelte.config.js for
  the `use:melt={$store}` directives to work.

  Behavior:
  - Focus → popover opens with the full list
  - Type → case-insensitive filter (label + value)
  - Click / Enter → commit option; one Backspace clears the field

  @component
-->

<script lang="ts">
  import { createCombobox, melt } from "@melt-ui/svelte";

  export interface ComboboxOption {
    value: string;
    label: string;
  }

  interface Props {
    value: string;
    options: ComboboxOption[];
    placeholder?: string;
    disabled?: boolean;
  }

  let { value = $bindable(""), options, placeholder = "", disabled = false }: Props = $props();

  const {
    elements: { menu, input, option },
    states: { open, inputValue, selected, touchedInput, highlighted },
  } = createCombobox<ComboboxOption>({
    forceVisible: true,
    onSelectedChange: ({ next }) => {
      if (next) value = next.value;
      return next;
    },
  });

  // Sync the externally-bound `value` -> selected/inputValue on first
  // render (and again when an async load supplies a value later).
  $effect(() => {
    const match = options.find((o) => o.value === value);
    if (match && $selected?.value !== match.value) {
      selected.set(match);
      inputValue.set(match.label);
    } else if (!match && value && $inputValue !== value) {
      inputValue.set(value);
    }
  });

  // Free-form typing — keep external value in sync even when the typed
  // string isn't a known option (tz aliases, custom locales).
  $effect(() => {
    if (!$touchedInput) return;
    const typed = $inputValue;
    const match = options.find((o) => o.label === typed || o.value === typed);
    value = match ? match.value : typed;
  });

  const filtered = $derived.by(() => {
    if (!$touchedInput) return options;
    const q = $inputValue.toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  });

  // One Backspace clears the entire field. The prefilled detected
  // value is always-replace, not always-edit — char-at-a-time deletion
  // was busy work.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Backspace" && $inputValue.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      inputValue.set("");
      touchedInput.set(true);
      selected.set(undefined);
      value = "";
    }
  }
</script>

<div class="combobox">
  <input
    use:melt={$input}
    type="text"
    class="trigger"
    {placeholder}
    {disabled}
    onkeydown={onKeydown}
  />
  <svg
    class="caret"
    aria-hidden="true"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
  >
    <path d="m4 6 4 4 4-4" />
  </svg>
  {#if $open}
    <ul use:melt={$menu} class="menu">
      {#each filtered as opt, i (opt.value)}
        <li
          use:melt={$option({ value: opt, label: opt.label })}
          class="option"
          class:highlighted={$highlighted?.value === opt.value}
        >
          <span class="opt-label">{opt.label}</span>
          <span class="opt-value">{opt.value}</span>
        </li>
      {:else}
        <li class="empty">No matches</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combobox {
    position: relative;
  }

  .trigger {
    background-color: var(--surface-bright);
    block-size: 2.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-bright);
    font: inherit;
    inline-size: 100%;
    line-height: 1.2;
    padding-block: 0;
    padding-inline: 0.75rem 2rem;
  }

  .trigger:focus {
    border-color: var(--blue-primary);
    outline: 2px solid color-mix(in oklab, var(--blue-primary) 30%, transparent);
    outline-offset: 0;
  }

  .trigger:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .caret {
    color: var(--text-faded);
    inset-block-start: 50%;
    inset-inline-end: 0.625rem;
    pointer-events: none;
    position: absolute;
    transform: translateY(-50%);
  }

  .menu {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    inset-block-start: calc(100% + 4px);
    inset-inline: 0;
    list-style: none;
    margin: 0;
    max-block-size: 16rem;
    overflow: auto;
    padding: 0.25rem;
    position: absolute;
    z-index: 10;
  }

  .option {
    align-items: baseline;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    padding: 0.5rem 0.625rem;
  }

  .option.highlighted,
  .option[data-highlighted] {
    background-color: var(--highlight);
  }

  .option[data-selected] {
    background-color: var(--highlight-bright);
  }

  .opt-label {
    color: var(--text-bright);
    font-size: 0.875rem;
  }

  .opt-value {
    color: var(--text-faded);
    font-size: 0.75rem;
  }

  .empty {
    color: var(--text-faded);
    font-size: 0.875rem;
    padding: 0.5rem 0.625rem;
  }
</style>
