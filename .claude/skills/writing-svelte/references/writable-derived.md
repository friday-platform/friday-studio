# Writable Derived

Reference: https://sveltejs.github.io/eslint-plugin-svelte/rules/prefer-writable-derived/

## The Pattern

In Svelte 5, `$derived` declared with `let` (not `const`) produces a writable
derived value. It syncs from its source reactively, but can also be locally
mutated — for example, via `bind:value`.

This replaces the old `$state` + `$effect` sync pattern.

### Before (flagged by `svelte/prefer-writable-derived`)

```svelte
<script lang="ts">
  let { value }: { value: string } = $props();

  let internal = $state(value);

  $effect(() => {
    internal = value;
  });
</script>

<textarea bind:value={internal}></textarea>
```

### After

```svelte
<script lang="ts">
  let { value }: { value: string } = $props();

  let internal = $derived(value);
</script>

<textarea bind:value={internal}></textarea>
```

`let internal = $derived(value)` does two things:

1. Reactively syncs `internal` whenever `value` changes (like the old `$effect`)
2. Allows local writes because it's `let`, not `const` (like the old `$state`)

## When to Use

Use writable derived when a component needs to:

- Track a prop as its initial/synced value
- Allow the user to edit that value locally (e.g. form inputs)
- Reset to the prop value when the parent updates

This is the standard pattern for self-managing input components that receive
`value` as a prop and report changes via `onblur` callbacks.

## `const` vs `let`

- `const derived = $derived(expr)` — read-only derived value, errors on write
- `let derived = $derived(expr)` — writable derived, can be mutated locally

Use `const` for values you never reassign (query data, computed displays). Use
`let` when the value needs to be locally editable.

## Derived Objects (Deep Reactivity)

Svelte 5 state is deeply reactive. A `$derived` object lets you group related
fields and mutate individual properties — no need for separate variables per
field.

```svelte
<script lang="ts">
  const skill = $derived(skillQuery.data);

  let draft = $derived({
    title: skill?.title ?? "",
    slug: skill?.name ?? "",
    description: skill?.description ?? "",
  });
</script>

<!-- Each property is independently writable and reactive -->
<input bind:value={draft.title} />
<input bind:value={draft.slug} />
<textarea bind:value={draft.description}></textarea>
```

When `skill` changes (e.g. query refetch), the whole `draft` object resyncs.
Between resyncs, individual properties can be mutated via `bind:value` or
assignment (`draft.title = "new"`). This avoids a proliferation of separate
`let x = $derived(...)` declarations.

## What the Lint Rule Detects

`svelte/prefer-writable-derived` (included in `plugin:svelte/recommended`) flags
any variable that:

1. Is initialized with `$state()`
2. Has an `$effect()` or `$effect.pre()` that reassigns it
3. The effect body contains only a single assignment

All three conditions must be true. Complex effects with multiple statements or
side effects are not flagged.
