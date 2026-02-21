---
name: feature-flags
description: Manages feature flags in the web-client. Load when adding, removing, checking, or testing feature flags. Covers the full lifecycle — adding new flags, overriding via env vars, checking if flags on the current branch are ready to ship, and removing flags once shipped.
user-invocable: false
---

# Feature Flags

Feature flags gate unfinished UI work in `apps/web-client` so it can merge to
main without being visible to users. Once the feature is ready, remove the flag.

## Where Things Live

| What | File |
|------|------|
| Flag interface + defaults | `apps/web-client/src/lib/app-context.svelte.ts` — `FeatureFlags` interface and `DEFAULT_FLAGS` object |
| Build-time injection | `apps/web-client/vite.config.ts` — parses `FEATURE_FLAGS` env var into `__FEATURE_FLAGS__` global |
| Global type declaration | `apps/web-client/src/app.d.ts` — declares `__FEATURE_FLAGS__: string[]` |

## Overriding Flags During Development

Pass a comma-separated list of flag names to enable via the `FEATURE_FLAGS` env
var:

```bash
# Enable specific flags
FEATURE_FLAGS=ENABLE_GLOBAL_SKILLS,ENABLE_LIBRARY_FILTERS deno task dev

# Enable all workspace nav items
FEATURE_FLAGS=ENABLE_WORKSPACE_NAV_ACTIVITY,ENABLE_WORKSPACE_NAV_RESOURCES,ENABLE_WORKSPACE_NAV_CONVERSATIONS,ENABLE_WORKSPACE_NAV_JOBS deno task dev
```

Flags not listed remain `false`. No env var = all flags off (production
defaults).

## Checking Flags in Components

```svelte
<script lang="ts">
  import { getAppContext } from "$lib/app-context.svelte";
  const appCtx = getAppContext();
</script>

{#if appCtx.flags.ENABLE_WORKSPACE_NAV_RESOURCES}
  <NavItem href="..." label="Resources" />
{/if}
```

## Branch Review: Are Any Flags Ready to Ship?

**Every time you review or finish work on a branch**, check whether any feature
flags used in the branch are now fully implemented. Do this by:

1. Find all flag references in the branch diff:
   ```bash
   git diff main...HEAD -- apps/web-client | grep -E 'ENABLE_[A-Z_]+'
   ```
2. For each flag found, check if the gated feature is complete — all UI,
   behavior, and tests are in place with no remaining TODOs behind the flag.
3. **Ask the user**: "It looks like `ENABLE_X` is fully implemented on this
   branch. Can we remove the feature flag and ship it visible by default?"
4. If yes, follow the removal steps below.

## Adding a New Flag

1. **`FeatureFlags` interface** in `app-context.svelte.ts` — add the new
   property (boolean)
2. **`DEFAULT_FLAGS` object** in `app-context.svelte.ts` — add the key with
   value `false`
3. Use `appCtx.flags.ENABLE_YOUR_FLAG` in components
4. Verify with: `FEATURE_FLAGS=ENABLE_YOUR_FLAG deno task dev`

## Removing a Flag (Feature Is Ready to Ship)

When a feature behind a flag is complete and approved for shipping:

1. **Remove the property** from the `FeatureFlags` interface in
   `app-context.svelte.ts`
2. **Remove the key** from `DEFAULT_FLAGS` in `app-context.svelte.ts`
3. **Remove all conditional checks** — find every `{#if appCtx.flags.ENABLE_X}`
   and `appCtx.flags.ENABLE_X` reference in components. Replace conditional
   blocks with just the inner content (the feature is now always on):
   ```svelte
   <!-- Before -->
   {#if appCtx.flags.ENABLE_WORKSPACE_NAV_RESOURCES}
     <NavItem href="..." label="Resources" />
   {/if}

   <!-- After -->
   <NavItem href="..." label="Resources" />
   ```
4. **Search thoroughly** — flags may be referenced in TypeScript files too:
   ```bash
   grep -r "ENABLE_X" apps/web-client/src/
   ```
5. **Type check** — `npx svelte-check --threshold error` will catch any
   remaining references to the deleted flag as type errors

## Testing Feature Flags

When writing tests for flagged features:

- Test the feature behavior directly (with the flag enabled), not the flag
  mechanism itself
- If a component renders conditionally based on a flag, test both states only if
  the off-state has meaningful behavior (not just "nothing renders")
- The flag system itself (`buildFeatureFlags`, env var parsing) doesn't need
  tests — it's trivial plumbing
