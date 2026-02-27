# Skills UI API Integration

## Problem Statement

The skills UI (listing page, detail page with title/description/content editing)
is wired up with hardcoded mock data. The backend skills API was merged in #2031
with a global catalog model (`@namespace/name`, immutable versioning), but the
frontend can't talk to it yet. Additionally, the backend lacks a get-by-id
endpoint and a `title` field — both needed for the UI.

## Solution

1. Add a `title` column to the skills schema (nullable — CLI-published skills
   won't have one)
2. Add a `getById` method to the storage adapter and a `GET /by-id/:id` route
3. Wire the Hono RPC client through to the web client
4. Replace mock data in listing and detail page loaders with real API calls
5. On first save, generate a kebab-case slug from the title for the `name` field
6. All UI-created skills use the `friday` namespace, omitted from display

## Data Mapping

| UI field    | Backend field  | Notes                                  |
| ----------- | -------------- | -------------------------------------- |
| Title       | `title`        | New nullable column, display name      |
| Slug        | `name`         | Kebab-case, auto-generated from title  |
| Description | `description`  | Top-level field, already exists        |
| Content     | `instructions` | Markdown body, already exists          |
| Namespace   | `namespace`    | Hardcoded `"friday"`, omitted from UI  |
| ID          | `id`           | ULID primary key, used for URL routing |

## Implementation

### 1. Add `title` to skills schema

**`packages/skills/src/schemas.ts`:**

Add `title` to all four schemas:

```typescript
// PublishSkillInputSchema — optional, UI sends it, CLI doesn't
title: z.string().min(1).optional(),

// SkillSchema — nullable (CLI-published skills have null)
title: z.string().nullable(),

// SkillDbRowSchema — nullable (matches DB column)
title: z.string().nullable(),

// SkillSummarySchema — nullable (listing display)
title: z.string().nullable(),
```

**`packages/skills/src/local-adapter.ts`:**

Add `title TEXT` column to the CREATE TABLE statement:

```sql
CREATE TABLE IF NOT EXISTS skills (
  ...existing columns...
  title TEXT,
  ...
);
```

Update `migrateIfNeeded()` to handle the new column. The existing migration
drops the table when `namespace` is missing. Add a second migration clause: if
the table exists and has `namespace` but lacks `title`, run
`ALTER TABLE skills ADD COLUMN title TEXT`. This preserves existing data.

```typescript
private migrateIfNeeded(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(skills)").all() as { name: string }[];
  if (cols.length === 0) return;
  const hasNamespace = cols.some((c) => c.name === "namespace");
  if (!hasNamespace) {
    // ...existing drop logic...
  }
  const hasTitle = cols.some((c) => c.name === "title");
  if (!hasTitle) {
    db.exec("ALTER TABLE skills ADD COLUMN title TEXT");
  }
}
```

Update the INSERT in `publish()` to include `title` (from
`input.title ?? null`).

Update `rowToSkill()` to map `r.title` to the `Skill` object.

**`packages/skills/src/cortex-adapter.ts`:**

Add `title: string | null` to the `CortexSkillMetadata` interface. Include it in
both the primary skill metadata (line 74) and archive metadata (line 93) objects
in `publish()`. Read it back in `toSkill()` (line 328). Include it in the
listing map in `list()`.

### 2. Add `getById` to storage adapter

**`packages/skills/src/storage.ts`:**

Add to the `SkillStorageAdapter` interface:

```typescript
getById(id: string): Promise<Result<Skill | null, string>>;
```

Add proxy to the `SkillStorage` object:

```typescript
getById: (...args) => getStorage().getById(...args),
```

**`packages/skills/src/local-adapter.ts`:**

```typescript
async getById(id: string): Promise<Result<Skill | null, string>> {
  const db = await this.getDb();
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
  return success(row ? this.rowToSkill(row) : null);
}
```

Note: each version row has a unique `id` (ULID), so this returns a single
specific version — not "latest". This is fine because the listing page returns
the latest version's `id`, and on save we'll navigate to the newly published
version's `id`.

**`packages/skills/src/cortex-adapter.ts`:**

```typescript
async getById(id: string): Promise<Result<Skill | null, string>> {
  const url = `/objects?metadata.type=skill&metadata.skill_id=${encodeURIComponent(id)}`;
  const objects = await this.request<CortexObject[]>("GET", url);
  const obj = objects?.[0];
  if (!obj) return success(null);

  const instructions = await this.request<string>("GET", `/objects/${obj.id}`, undefined, false);
  if (instructions === null) return fail("Failed to load skill content");

  const archive = await this.loadArchive(obj.metadata.skill_id);
  return success(this.toSkill(obj.metadata, instructions, archive));
}
```

### 3. Add `GET /api/skills/by-id/:id` route

**`apps/atlasd/routes/skills.ts`:**

Add a new route in the chain AFTER the `GET /` (list) route and BEFORE
`GET /:namespace/:name`. This ordering is critical — `by-id` is a literal path
segment, so it won't conflict with `:namespace` if placed first. But placing it
after `/` and before `/:namespace/:name` keeps the chain readable.

```typescript
// ─── GET BY ID ──────────────────────────────────────────────────────────────
.get("/by-id/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
  const { id } = c.req.valid("param");
  const result = await SkillStorage.getById(id);
  if (!result.ok) return c.json({ error: result.error }, 500);
  if (!result.data) return c.json({ error: "Skill not found" }, 404);

  const { archive: _, ...skill } = result.data;
  return c.json({ skill });
})
```

Unauthenticated, matching the existing GET routes. The route is already mounted
at `/api/skills` in `apps/atlasd/src/atlas-daemon.ts` (line 630:
`this.app.route("/api/skills", skillsRoutes)`), so no mounting changes needed.

### 4. Wire up Hono RPC client

The route type export + client wiring follows the exact pattern used by all
other routes (jobs, workspaces, chat, etc.):

**`apps/atlasd/routes/skills.ts`** — Add at end of file:

```typescript
export type SkillsRoutes = typeof skillsRoutes;
```

**`apps/atlasd/mod.ts`** — Add with the other route type exports (alphabetical):

```typescript
export type { SkillsRoutes } from "./routes/skills.ts";
```

**`packages/client/v2/mod.ts`** — Import and add to client:

```typescript
import type { SkillsRoutes } from "@atlas/atlasd";

export const client = {
  // ...existing entries...
  skills: hc<SkillsRoutes>(`${baseUrl}/api/skills`),
};
```

### 5. Add skills query module

**`apps/web-client/src/lib/queries/skills.ts`** (new file)

Follow the pattern from `queries/spaces.ts`:

```typescript
import { client, type InferResponseType, parseResult } from "@atlas/client/v2";

type SkillsListResponse = InferResponseType<
  typeof client.skills.index.$get,
  200
>;
type SkillByIdResponse = InferResponseType<
  typeof client.skills["by-id"][":id"]["$get"],
  200
>;

export async function listSkills(): Promise<SkillsListResponse> {
  const res = await parseResult(
    client.skills.index.$get({ query: { namespace: "friday" } }),
  );
  if (!res.ok) throw new Error("Failed to load skills");
  return res.data;
}

export async function getSkillById(
  id: string,
): Promise<SkillByIdResponse> {
  const res = await parseResult(
    client.skills["by-id"][":id"].$get({ param: { id } }),
  );
  if (!res.ok) throw new Error("Failed to load skill");
  return res.data;
}

export async function publishSkill(
  name: string,
  input: { title?: string; description: string; instructions: string },
): Promise<{ namespace: string; name: string; version: number }> {
  const res = await parseResult(
    client.skills[":namespace"][":name"].$post({
      param: { namespace: "@friday", name },
      json: input,
    }),
  );
  if (!res.ok) throw new Error("Failed to publish skill");
  return res.data.published;
}
```

Note: the exact Hono RPC path syntax (`client.skills["by-id"][":id"].$get`)
depends on how Hono generates client types from the route chain. If the
generated types use a different path structure, adjust accordingly — inspect the
type with IDE hover to confirm.

### 6. Update listing page

**`apps/web-client/src/routes/(app)/skills/+page.ts`:**

Replace the mock `Skill` type and hardcoded data:

```typescript
import { listSkills } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const { skills } = await listSkills();
  return { skills };
};
```

Remove the local `Skill` type — use the inferred type from `listSkills()`.

**`apps/web-client/src/routes/(app)/skills/+page.svelte`:**

Update the TanStack Table column to use new fields. The `SkillColumn` component
needs updated props — replace `spaceCount`/`assetCount` with just `name` and
`description`:

```typescript
cell: (info) =>
  renderComponent(SkillColumn, {
    name: info.row.original.title ?? info.row.original.name,
    description: info.row.original.description,
  }),
```

The `rowPath` already uses `skillId: item.id` and the route is
`/skills/[skillId]`, so it continues to work as-is.

**`apps/web-client/src/routes/(app)/skills/(components)/skill-column.svelte`:**

Simplify to two props:

```typescript
type Props = { name: string; description: string };
let { name, description }: Props = $props();
```

Remove the `spaceCount`/`assetCount` stats from the template. Keep the name
header and description.

### 7. Add `id` to listing response

The listing endpoint returns `SkillSummary` which currently lacks `id`. The UI
needs `id` to link rows to `/skills/[id]`.

**`packages/skills/src/schemas.ts`:**

```typescript
export const SkillSummarySchema = z.object({
  id: z.string(), // ← add
  namespace: NamespaceSchema,
  name: SkillNameSchema,
  title: z.string().nullable(), // ← add (from step 1)
  description: z.string(),
  latestVersion: z.number().int().positive(),
});
```

**`packages/skills/src/local-adapter.ts`:**

The listing query (line 124) currently selects
`s.namespace, s.name, s.description, s.version as latestVersion`. Add `s.id`:

```sql
SELECT s.id, s.namespace, s.name, s.title, s.description, s.version as latestVersion
FROM skills s
INNER JOIN (
  SELECT namespace, name, MAX(version) as max_version
  FROM skills
  GROUP BY namespace, name
) latest ON s.namespace = latest.namespace
  AND s.name = latest.name
  AND s.version = latest.max_version
```

Update the `rows` type assertion to include `id: string` and
`title: string | null`.

**`packages/skills/src/cortex-adapter.ts`:**

Update the listing map (line 183) to include `id: o.metadata.skill_id` and
`title: o.metadata.title`.

### 8. Update detail page

**`apps/web-client/src/routes/(app)/skills/[skillId]/+page.ts`:**

Replace mock data with API call:

```typescript
import { error } from "@sveltejs/kit";
import { getSkillById } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  try {
    const { skill } = await getSkillById(params.skillId);
    return { skill };
  } catch {
    return error(404, "unable to load skill");
  }
};
```

Remove the local `Skill` type and all hardcoded mock data.

**`apps/web-client/src/routes/(app)/skills/[skillId]/+page.svelte`:**

Update `$state` bindings to map from the API response:

```typescript
// Before (mock data):
let content = $state(data.skill.content);
let name = $state(data.skill.name);

// After (API response):
let content = $state(data.skill.instructions);
let name = $state(data.skill.title ?? data.skill.name);
```

The `Page.Title` component accepts a `value` prop (not `title`). The existing
`bind:value={name}` binding is correct.

Wire save to publish a new version. The `publishSkill` function needs the
kebab-case `name` (slug), not the display title. Store the original
`data.skill.name` separately and pass it to `publishSkill`:

```typescript
const slug = data.skill.name; // immutable kebab-case slug

async function save() {
  await publishSkill(slug, {
    title: name,
    description,
    instructions: content,
  });
}
```

For NEW skills (no slug yet), see step 9 below.

### 9. Title-to-slug generation

Client-side, in the `publishSkill` query function or at the call site. On first
save of a new skill (no existing `name`), generate the slug from the title:

```typescript
function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
```

Validate the generated slug against `SkillNameSchema` regex
(`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) before sending. Subsequent saves reuse the
existing `name` — the slug is immutable after first publish.

Place `toSlug` in a utility file (e.g., `$lib/utils/slug.ts`) or inline in the
detail page component.

Note: creating a NEW skill (no existing ID) is a different flow than editing.
The detail page currently only handles editing existing skills. New skill
creation UI is a follow-up — for now, skills must exist (published via CLI or
API) before they appear in the UI. The slug generation logic is included here
for completeness but will be used when we add the "create skill" flow.

## Key Decisions

**ID-based routing over namespace/name.** The URL is `/skills/[id]` using the
ULID primary key. This avoids encoding `@namespace/name` in URLs and decouples
the URL from the skill's identity. Requires a new `getById` endpoint since the
backend only supports lookup by namespace/name today. Note: each version has its
own `id` — the listing returns the latest version's `id`, and after publishing a
new version the UI should navigate to the new version's `id`.

**Title as a new DB column, not frontmatter.** Per the Agent Skills spec
(https://agentskills.io/specification#frontmatter-required), frontmatter fields
are agent-facing configuration (`name`, `description`, `allowed-tools`, etc.). A
display title is a UI concern and doesn't belong in the spec-defined
frontmatter. Nullable because CLI-published skills won't have one.

**Publish-on-save, not update.** The backend has no update endpoint — editing
publishes a new version. This is transparent to the user; version numbers are
not displayed in the UI. After save, the response includes the new version's
`{ namespace, name, version }`. To get the new `id`, either return it from the
publish endpoint (preferred — small backend change to return `id` alongside
`version`) or re-fetch via `GET /@friday/:name`.

**Hardcoded `friday` namespace.** All skills created through the UI use
`@friday/[slug]`. The namespace is omitted from display. This can be extended
later if multi-namespace support is needed.

**`id` added to listing response.** `SkillSummary` gains an `id` field so the
listing page can link to `/skills/[id]` without a second API call.

**Slug display fallback.** When a skill has no `title` (CLI-published), display
the raw slug as-is. E.g., `code-review` stays `code-review`. No formatting.

## Out of Scope

- New skill creation UI (skills must exist before appearing in listing)
- Skill deletion UI
- Version history UI
- Assets and references sections (behind feature flags)
- Skill search/filtering (behind `ENABLE_SKILLS_FILTERS` flag)
- Multi-namespace support
- Skill sharing
- Archive/file upload

## Reference: Existing File Locations

Files that exist and need modification:

```
packages/skills/src/schemas.ts          # Zod schemas (Skill, SkillSummary, PublishSkillInput, SkillDbRow)
packages/skills/src/storage.ts          # SkillStorageAdapter interface + SkillStorage proxy
packages/skills/src/local-adapter.ts    # SQLite adapter (LocalSkillAdapter class)
packages/skills/src/cortex-adapter.ts   # Cortex blob adapter (CortexSkillAdapter class)
apps/atlasd/routes/skills.ts            # Hono route definitions (skillsRoutes)
apps/atlasd/mod.ts                      # Type re-exports for client consumption
apps/atlasd/src/atlas-daemon.ts         # Route mounting (already mounts skillsRoutes at /api/skills, line 630)
packages/client/v2/mod.ts               # Hono RPC client (hc<RouteType> pattern)
```

Files that exist and need modification (web client):

```
apps/web-client/src/routes/(app)/skills/+page.ts                    # Listing loader (has mock data)
apps/web-client/src/routes/(app)/skills/+page.svelte                # Listing UI (TanStack Table)
apps/web-client/src/routes/(app)/skills/(components)/skill-column.svelte  # Table cell (has spaceCount/assetCount)
apps/web-client/src/routes/(app)/skills/[skillId]/+page.ts          # Detail loader (has mock data)
apps/web-client/src/routes/(app)/skills/[skillId]/+page.svelte      # Detail UI (Page.Title, MarkdownEditor)
```

Files to create:

```
apps/web-client/src/lib/queries/skills.ts    # API query functions (follows queries/spaces.ts pattern)
```

## Testing

- `packages/skills/tests/local-adapter.test.ts` — Add `getById` test, verify
  `title` round-trips through publish/get, verify `title: undefined` (omitted)
  stores as `null`
- `apps/atlasd/routes/skills.test.ts` — Add test for `GET /api/skills/by-id/:id`
  endpoint, verify 404 for unknown id
- Verify listing returns `id` and `title` fields
- Verify `title: null` works for CLI-published skills (backwards compat)
- Verify existing tests still pass (title is optional, so no existing test
  should break)

---

## Revision 2: Stable URLs, Auto-Save & Skill Creation

### Problem

The original plan used per-version ULIDs (`id`) for URL routing
(`/skills/[skillId]`). Each publish creates a new row with a new `id`, so:

- Bookmarks go stale after the first edit
- Browser history points to old versions
- Favorites would reference a specific version, not the skill itself
- Auto-save was never implemented — edits weren't persisted

The `(namespace, name)` composite is the actual stable identity of a skill
across versions, but the URL didn't use it.

### Changes from Original Plan

| Original                              | Revised                                    |
| ------------------------------------- | ------------------------------------------ |
| Route: `/skills/[skillId]`            | Route: `/skills/[namespace]/[name]`        |
| Detail fetches via `GET /by-id/:id`   | Detail fetches via `GET /:namespace/:name` |
| ID is the URL identity                | `namespace/name` is the URL identity       |
| No skill creation UI                  | `/skills/new` page with redirect on save   |
| Slug is immutable after first publish | Slug regenerates when title changes        |
| No auto-save                          | Save on blur, navigation, and tab close    |

### Data Mapping (revised)

| UI field    | Backend field    | Notes                                   |
| ----------- | ---------------- | --------------------------------------- |
| Title       | `title`          | Display name, drives slug generation    |
| Slug        | `name`           | Kebab-case, regenerated on title change |
| Description | `description`    | Top-level field                         |
| Content     | `instructions`   | Markdown body                           |
| Namespace   | `namespace`      | Hardcoded `"friday"`, used in URL       |
| URL         | `namespace/name` | Stable across versions                  |

### Implementation

#### R1. Slug generation utility

**`packages/skills/src/slug.ts`** (new file)

```typescript
export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
```

Exported from `packages/skills/src/mod.ts`. Also duplicated client-side in
`apps/web-client/src/lib/utils/slug.ts` — the web client can't import from
`@atlas/skills` (server-only, pulls SQLite FFI). The function is 4 lines and
deterministic, so duplication is acceptable.

#### R2. Publish handles renames

When `publish()` receives a `title` that generates a different slug than the
current `name` parameter, it renames all existing versions before inserting the
new one. This keeps the `GROUP BY namespace, name` listing query from creating
duplicate entries.

**`packages/skills/src/storage.ts`** — Update return type:

```typescript
publish(
  namespace: string,
  name: string,
  createdBy: string,
  input: PublishSkillInput,
): Promise<Result<{ id: string; version: number; name: string }, string>>;
```

The new `name` field in the result is the effective name after any rename. The
route handler uses this instead of the URL parameter.

**`packages/skills/src/local-adapter.ts`** — Modify `publish()`:

```typescript
async publish(
  namespace: string,
  name: string,
  createdBy: string,
  input: PublishSkillInput,
): Promise<Result<{ id: string; version: number; name: string }, string>> {
  const db = await this.getDb();
  const id = ulid();
  const now = new Date().toISOString();

  // If title provided, check if name needs updating
  let effectiveName = name;
  if (input.title) {
    const slug = toSlug(input.title);
    if (slug && slug !== name) {
      // Check new name isn't taken by a different skill
      const conflict = db.prepare(
        "SELECT 1 FROM skills WHERE namespace = ? AND name = ? LIMIT 1"
      ).get(namespace, slug);
      if (conflict) {
        return fail(`Skill name "${slug}" already exists`);
      }
      // Rename all existing versions
      db.prepare(
        "UPDATE skills SET name = ? WHERE namespace = ? AND name = ?"
      ).run(slug, namespace, name);
      effectiveName = slug;
    }
  }

  // Get latest version using effective name (handles renamed rows)
  const row = db
    .prepare("SELECT MAX(version) as max_version FROM skills WHERE namespace = ? AND name = ?")
    .get(namespace, effectiveName) as { max_version: number | null } | undefined;
  const version = (row?.max_version ?? 0) + 1;

  try {
    db.prepare(`
      INSERT INTO skills (id, namespace, name, version, title, description, frontmatter, instructions, archive, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, namespace, effectiveName, version,
      input.title ?? null, input.description,
      JSON.stringify(input.frontmatter ?? {}),
      input.instructions, input.archive ?? null,
      createdBy, now,
    );
    return success({ id, version, name: effectiveName });
  } catch (e) {
    return fail(stringifyError(e));
  }
}
```

**`packages/skills/src/cortex-adapter.ts`** — Update return type to include
`name` (pass through unchanged — cortex doesn't support renames yet):

```typescript
return success({ id, version, name });
```

**`apps/atlasd/routes/skills.ts`** — Use `result.data.name` in response:

```typescript
return c.json(
  {
    published: {
      id: result.data.id,
      namespace,
      name: result.data.name,
      version: result.data.version,
    },
  },
  201,
);
```

#### R3. Change frontend route structure

Delete the `[skillId]` route directory. Create two new routes:

```
apps/web-client/src/routes/(app)/skills/new/           # Skill creation
apps/web-client/src/routes/(app)/skills/[namespace]/[name]/  # Skill editing
```

SvelteKit matches static segments (`new`) before dynamic ones
(`[namespace]/[name]`), so no conflict.

**`apps/web-client/src/lib/app-context.svelte.ts`** — Update routes:

```typescript
skills: {
  list: resolve("/skills", {}),
  new: resolve("/skills/new", {}),
  item: (namespace: string, name: string) =>
    resolve("/skills/[namespace]/[name]", { namespace, name }),
},
```

#### R4. Update queries

**`apps/web-client/src/lib/queries/skills.ts`:**

Replace `getSkillById` with `getSkill` using the existing
`GET /:namespace/:name` endpoint (returns latest version):

```typescript
export async function getSkill(namespace: string, name: string) {
  const res = await parseResult(
    client.skills[":namespace"][":name"].$get({
      param: { namespace: `@${namespace}`, name },
    }),
  );
  if (!res.ok) throw new Error("Failed to load skill");
  return res.data;
}
```

Update `publishSkill` to return full result including effective name:

```typescript
export async function publishSkill(
  namespace: string,
  name: string,
  input: { title?: string; description: string; instructions: string },
) {
  const res = await parseResult(
    client.skills[":namespace"][":name"].$post({
      param: { namespace: `@${namespace}`, name },
      json: input,
    }),
  );
  if (!res.ok) throw new Error("Failed to publish skill");
  return res.data.published;
}
```

Remove `createSkill` — replaced by the `/new` page flow.

#### R5. Update listing page

**`apps/web-client/src/routes/(app)/skills/+page.svelte`:**

Change row links from ID-based to namespace/name-based:

```typescript
rowPath={(item) =>
  resolve("/skills/[namespace]/[name]", {
    namespace: item.namespace,
    name: item.name,
  })
}
```

Change "New Skill" button to navigate to `/skills/new`:

```typescript
async function handleCreate() {
  await goto(resolve("/skills/new", {}));
}
```

Remove the `createSkill` import.

#### R6. New skill page (`/skills/new`)

**`apps/web-client/src/routes/(app)/skills/new/+page.svelte`:**

Same layout as the edit page (Page.Title, MarkdownEditor, description sidebar)
but starts with empty state. No API call on load.

State tracking:

```typescript
let title = $state("");
let description = $state("");
let content = $state("");
let created = false; // guards against double-create
```

Save logic — only fires when a title exists (can't create a skill without a
name):

```typescript
async function save() {
  if (!title.trim() || created) return;
  created = true;
  const slug = toSlug(title);
  const result = await publishSkill("friday", slug, {
    title,
    description,
    instructions: content,
  });
  await goto(appCtx.routes.skills.item(result.namespace, result.name), {
    replaceState: true,
  });
}
```

`toSlug` imported from `$lib/utils/slug.ts`. The `replaceState: true` option
replaces `/skills/new` in history so the back button goes to the listing, not
back to the create page.

Blur and navigation handlers match the edit page but gate on `title.trim()`.

#### R7. Update detail page (`/skills/[namespace]/[name]`)

**`apps/web-client/src/routes/(app)/skills/[namespace]/[name]/+page.ts`:**

```typescript
import { error } from "@sveltejs/kit";
import { getSkill } from "$lib/queries/skills";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  try {
    const { skill } = await getSkill(params.namespace, params.name);
    return { skill };
  } catch {
    return error(404, "unable to load skill");
  }
};
```

**`apps/web-client/src/routes/(app)/skills/[namespace]/[name]/+page.svelte`:**

Auto-save with dirty tracking, blur handlers on all three fields,
`beforeNavigate`, and `beforeunload`:

```typescript
let lastSaved = {
  title: data.skill.title ?? "",
  description: data.skill.description,
  instructions: data.skill.instructions,
};

function isDirty(): boolean {
  return (
    title !== lastSaved.title ||
    description !== lastSaved.description ||
    content !== lastSaved.instructions
  );
}

let saving = false;

async function save() {
  if (!isDirty() || saving) return;
  saving = true;
  try {
    const current = { title, description, instructions: content };
    const result = await publishSkill(
      data.skill.namespace,
      data.skill.name,
      {
        title: current.title || undefined,
        description: current.description,
        instructions: current.instructions,
      },
    );
    lastSaved = current;
    // If name changed (title rename), redirect to new URL
    if (result.name !== data.skill.name) {
      await goto(
        appCtx.routes.skills.item(result.namespace, result.name),
        { replaceState: true },
      );
    }
  } finally {
    saving = false;
  }
}

beforeNavigate(() => {
  if (isDirty()) save();
});

onMount(() => {
  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (isDirty()) {
      save();
      e.preventDefault();
    }
  }
  window.addEventListener("beforeunload", handleBeforeUnload);
  return () => window.removeEventListener("beforeunload", handleBeforeUnload);
});
```

The `saving` guard prevents double-publishes when blur and `beforeNavigate` fire
back-to-back (blur fires first when clicking a link).

On rename (`result.name !== data.skill.name`), `goto` with `replaceState`
updates the URL to the new namespace/name. SvelteKit re-runs the loader, which
fetches the latest version under the new name.

### Key Decisions (revised)

**Namespace/name routing over ID routing.** Reverses the original decision.
`(namespace, name)` is stable across versions — the
`UNIQUE(namespace, name,
version)` constraint guarantees it. Bookmarks,
favorites, and browser history all survive edits. The existing
`GET /:namespace/:name` endpoint already returns the latest version, so no new
backend endpoint is needed.

**Rename in the publish path.** When the API receives a title that generates a
different slug than the current `name`, it updates all existing versions' `name`
column in the same transaction before inserting the new version. This prevents
the `GROUP BY namespace, name` listing query from splitting a renamed skill into
two entries. Any frontend (web, CLI, future mobile) gets this behavior for free.

**Slug generated server-side.** The `toSlug()` function lives in `@atlas/skills`
and is the source of truth. The web client duplicates the function for the
`/new` page flow (needs a slug to construct the POST URL), but the server always
controls the final name. If the two implementations ever diverge, the server
wins on the next publish.

**`/skills/new` as a separate route.** Not a modal or inline create — a full
page with the same editor layout as the detail page. On first save (triggered by
title blur), the skill is created and the user is redirected to the permanent
URL. `replaceState` ensures the back button goes to the listing.

**`getById` stays but is unused by UI.** The `GET /by-id/:id` endpoint remains
for programmatic access (agent resolution, API consumers). The UI no longer
calls it.

### Updated Out of Scope

- ~~New skill creation UI~~ (now in scope — `/skills/new` page)
- Skill deletion UI
- Version history UI
- Assets and references sections (behind feature flags)
- Skill search/filtering (behind `ENABLE_SKILLS_FILTERS` flag)
- Multi-namespace support
- Skill sharing
- Archive/file upload
- Cortex adapter rename support (pass-through only)

### Updated File Locations

Files to modify:

```
packages/skills/src/storage.ts           # Update publish return type to include name
packages/skills/src/local-adapter.ts     # Rename logic in publish()
packages/skills/src/cortex-adapter.ts    # Update publish return type (pass-through)
packages/skills/src/mod.ts               # Export toSlug
apps/atlasd/routes/skills.ts             # Use result.data.name in publish response
apps/web-client/src/lib/queries/skills.ts           # getSkill replaces getSkillById, update publishSkill
apps/web-client/src/lib/app-context.svelte.ts       # Route helpers
apps/web-client/src/routes/(app)/skills/+page.svelte # Listing links + create button
```

Files to create:

```
packages/skills/src/slug.ts                                          # toSlug utility
apps/web-client/src/lib/utils/slug.ts                                # Client-side toSlug duplicate
apps/web-client/src/routes/(app)/skills/new/+page.ts                 # New skill loader (empty)
apps/web-client/src/routes/(app)/skills/new/+page.svelte             # New skill editor
apps/web-client/src/routes/(app)/skills/[namespace]/[name]/+page.ts  # Detail loader
apps/web-client/src/routes/(app)/skills/[namespace]/[name]/+page.svelte  # Detail editor + auto-save
```

Files to delete:

```
apps/web-client/src/routes/(app)/skills/[skillId]/+page.ts
apps/web-client/src/routes/(app)/skills/[skillId]/+page.svelte
```

### Testing (revision additions)

- `packages/skills/tests/local-adapter.test.ts`:
  - Publish with changed title renames all versions
  - Rename conflict (name already taken) returns error
  - Publish without title does not rename
  - `toSlug` generates valid `SkillNameSchema` values
- `apps/atlasd/routes/skills.test.ts`:
  - Publish with title returns effective `name` in response
  - Publish with changed title returns new `name`
- Verify listing links work with namespace/name routing
- Verify `/skills/new` → create → redirect flow
- Verify title change on detail page → rename → URL update
