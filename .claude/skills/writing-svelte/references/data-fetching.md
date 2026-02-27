# Data Fetching Patterns

## Hono RPC Client

All API calls go through the typed Hono client at `@atlas/client/v2`. Never use
raw `fetch` with `getAtlasDaemonUrl()`.

```ts
// Bad — raw fetch, no type safety
const response = await fetch(`${getAtlasDaemonUrl()}/api/skills/${id}`);
const data = await response.json();

// Good — typed Hono client
import { client, parseResult } from "@atlas/client/v2";

const res = await parseResult(
  client.skills[":skillId"].$get({ param: { skillId } }),
);
if (!res.ok) throw new Error("Failed to load skill");
return res.data;
```

The client is defined in `packages/client/v2/mod.ts`. Route types come from the
Hono route definitions in `apps/atlasd/routes/`.

### Query functions

Keep query functions in `src/lib/queries/*.ts`. They wrap the client call and
return typed data:

```ts
// src/lib/queries/skills.ts
import { client, parseResult } from "@atlas/client/v2";

export async function listSkills() {
  const res = await parseResult(
    client.skills.index.$get({
      query: { namespace: "friday", includeAll: "true" },
    }),
  );
  if (!res.ok) throw new Error("Failed to load skills");
  return res.data;
}
```

## TanStack Query + SvelteKit Load (SSR)

Use both `+page.ts` for SSR and `createQuery` in the component for client-side
reactivity. The layout sets `enabled: browser` on the QueryClient, so queries
only run client-side. Pass SSR data via `initialData` so the query doesn't
refetch on mount.

### Pattern: `+page.ts` loads, component queries with same key

```ts
// +page.ts — runs server-side for SSR
import { listSkills } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const { skills } = await listSkills();
  return { skills };
};
```

```svelte
<!-- +page.svelte — uses initialData from load, same query key -->
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { listSkills } from "$lib/queries/skills";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const skillsQuery = createQuery(() => ({
    queryKey: ["skills"],
    queryFn: () => listSkills(),
    initialData: { skills: data.skills },
    select: (data) => data.skills,
  }));

  const skills = $derived(skillsQuery.data ?? []);
</script>
```

### Parameterized query with SSR

```ts
// +page.ts
import { error } from "@sveltejs/kit";
import { getSkillById } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const skill = await getSkillById(params.skillId).catch(() => {
    error(404, "unable to load skill");
  });
  return { initialSkill: skill };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { getSkillById } from "$lib/queries/skills";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const skillQuery = createQuery(() => ({
    queryKey: ["skill", page.params.skillId],
    queryFn: () => getSkillById(page.params.skillId),
    initialData: data.initialSkill,
    select: (data) => data.skill,
  }));

  const skill = $derived(skillQuery.data);
</script>
```

### Key rules

- Always keep `+page.ts` for SSR — don't rely on client-only `createQuery`
- Pass SSR data as `initialData` so the same key doesn't fetch twice
- Use `select` to unwrap response shapes at the query level
- No `invalidateAll()` — TanStack Query handles refetching automatically

## Mutations

Use `createMutation` for all write operations. It tracks pending state and
provides `onSuccess` hooks.

### Simple mutation (create + navigate)

```svelte
<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { createSkill } from "$lib/queries/skills";

  const createMut = createMutation(() => ({
    mutationFn: () => createSkill(),
    onSuccess: async ({ skillId }) => {
      await goto(`/skills/${skillId}`);
    },
  }));
</script>

<button onclick={() => createMut.mutate()} disabled={createMut.isPending}>
  New Skill
</button>
```

### Mutation that reads component state

The mutation function can close over component state directly. No need to pass
all fields as parameters:

```svelte
<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";

  // skill comes from createQuery
  const skill = $derived(skillQuery.data);

  const publishMut = createMutation(() => ({
    mutationFn: () => {
      if (!skill) throw new Error("No skill loaded");
      return publishSkill(skill.namespace, slug, {
        title: title || undefined,
        instructions: content,
        skillId: skill.skillId,
      });
    },
    onSuccess: () => {
      // navigate, show toast, etc.
    },
  }));

  function save() {
    if (!skill || publishMut.isPending) return;
    publishMut.mutate();
  }
</script>
```

### Key rules

- Use `isPending` instead of manual `saving` flags
- Use `onSuccess` for side effects (navigation, toasts)
- Use `mutate()` for fire-and-forget, `mutateAsync()` when you need to await
- Don't redeclare all fields as mutation input types — close over component state
