# State Patterns

## Components Own Their State

Components should manage their own internal editing state. The parent passes a
`value` prop and receives changes via a callback (typically `onblur`). Don't use
`$bindable()` for values that flow from query data.

### Pattern: self-managing input component

Use a writable derived (`let` + `$derived`) to sync from the parent prop while
allowing local edits. See [writable-derived.md](writable-derived.md) for details.

```svelte
<!-- title.svelte -->
<script lang="ts">
  type Props = {
    value: string;
    placeholder?: string;
    onblur?: (value: string) => void;
  };

  let { value, placeholder = undefined, onblur }: Props = $props();

  // Writable derived: syncs from prop, allows local edits via bind:value
  let internal = $derived(value);
</script>

<textarea
  bind:value={internal}
  {placeholder}
  onblur={() => onblur?.(internal)}
></textarea>
```

### Usage from parent

The parent passes query data as props and handles saves in callbacks:

```svelte
<script lang="ts">
  const skill = $derived(skillQuery.data);
</script>

{#if skill}
  <Title
    value={skill.title ?? ""}
    onblur={(title) => save({ title })}
  />

  <MarkdownEditor
    value={skill.instructions}
    onblur={(instructions) => save({ instructions })}
  />
{/if}
```

### What NOT to do

Don't mirror query data into local `$state` variables in the parent:

```svelte
<!-- Bad — duplicating query state -->
<script lang="ts">
  const skill = $derived(skillQuery.data);

  let title = $state("");
  let content = $state("");

  $effect.pre(() => {
    if (!skill) return;
    title = skill.title ?? "";
    content = skill.instructions;
  });
</script>

<Title bind:value={title} onblur={() => save()} />
```

Instead, pass query data directly as props and let the component hold its own
editing state.

## When to use `$state` in pages

Only use `$state` in the parent page for values that:

1. Don't have a dedicated child component managing them (e.g. a raw `<input>`
   or `<textarea>` in the page template)
2. Are derived from user interaction, not query data

Example — sidebar fields without dedicated components use writable derived:

```svelte
<script lang="ts">
  let slug = $derived(skill?.name ?? "");
  let description = $derived(skill?.description ?? "");
</script>

<input bind:value={slug} onblur={handleSlugBlur} />
<textarea bind:value={description} onblur={handleDescriptionBlur}></textarea>
```

## `$effect` vs `$effect.pre`

- **`$effect`** — runs after DOM update. Use for measuring DOM elements, syncing
  external libraries, or side effects that depend on rendered output.
- **`$effect.pre`** — runs before DOM update. Use when you need to update state
  before the next render cycle (rare).

**Default to `$effect`**. Only reach for `$effect.pre` when you have a specific
reason to run before the DOM updates.

```svelte
<script lang="ts">
  // Good — syncing prop to internal state (runs after, re-renders)
  $effect(() => {
    internal = value;
  });

  // Good — measuring DOM after render
  $effect(() => {
    resize(internal);
  });
</script>
```

## `$derived` for query data

Use `$derived` to extract values from query results. Don't copy into `$state`:

```svelte
<script lang="ts">
  // Good — derived from query
  const skill = $derived(skillQuery.data);
  const skills = $derived(skillsQuery.data ?? []);

  // Bad — copying query data into state (also flagged by prefer-writable-derived)
  let skill = $state(null);
  $effect(() => { skill = skillQuery.data; });
</script>
```
