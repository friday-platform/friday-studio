# Skills: Stable ID, Inline Creation & Auto-Description

## Revision 1 (2026-02-26)

**What changed from the original plan:**

- **Auto-description generation is now in scope.** The publish route calls
  `smallLLM()` from `@atlas/llm` when `descriptionManual` is false and
  instructions are non-empty. Best-effort — failures don't block the publish.
- **`skillId` uses nanoid instead of ULID.** 16-char lowercase alphanumeric
  (e.g. `v3xk7mq9p2rj4a8b`) for cleaner URLs. Per-version `id` remains ULID.
- **Migration backfill fix.** The original backfill set `skill_id = id` per row,
  giving each version its own `skill_id`. Fixed to group by `(namespace, name)`
  so all versions share one `skill_id`. A repair migration handles
  already-migrated databases.

**What's already implemented (before this revision):**

- Backend: schemas, storage interface, local adapter, migration, cortex adapter
- API: `POST /api/skills`, `GET /api/skills/:skillId`, `includeAll` on list,
  `skillId`/`descriptionManual` on publish
- Frontend: skillId-based routing, list page with status, detail page with
  auto-save, slug editing, `descriptionManual` tracking
- `skillId` now uses nanoid instead of ULID.
- migration backfill fix was implemented
- Tests: 41 storage tests, 33 route tests

**What still needs implementation:**

- Auto-description generation in the publish route (this revision)

---

## Problem Statement

Skills currently use `(namespace, name)` as their stable identity and URL key.
This breaks when a skill is renamed — bookmarks, browser history, and shared
links all go stale. There's also a separate `/new` page for skill creation that
requires solving unsaved-changes edge cases. Finally, descriptions are manually
written even though the instructions content could inform them.

## Solution

Introduce a stable `skillId` (ULID) that never changes across versions or
renames. Use it as the sole routing key. Remove the `/new` page — clicking "New
Skill" immediately creates a skill record and navigates to the detail page.
Auto-generate descriptions from instructions via LLM until the user manually
overrides.

## User Stories

1. As a skill author, I want a stable URL for my skill, so that bookmarks and
   shared links survive renames
2. As a skill author, I want to click "New Skill" and land directly in the
   editor, so that creation feels instant
3. As a skill author, I want the slug auto-generated from my first title, so
   that I don't have to think about naming conventions
4. As a skill author, I want to edit the slug independently after creation, so
   that I can fix or customize it
5. As a skill author, I want descriptions auto-generated from my instructions,
   so that I don't have to write them separately
6. As a skill author, I want my manual description edits preserved, so that
   auto-generation doesn't overwrite my work
7. As a skill author, I want to see which skills need attention in the list, so
   that I know which ones are incomplete
8. As a skill author, I want to start writing instructions before choosing a
   title, so that I can think about content first
9. As an agent, I want to only resolve skills that have a name and description,
   so that I don't use incomplete skills
10. As an API consumer, I want to filter the skill list by availability, so that
    I can see all skills or just available ones
11. As a skill author, I want namespace and name visible in the URL, so that
    links are human-readable even though routing ignores them
12. As a skill author, I want in-app navigation warnings when I have unsaved
    changes, so that I don't lose work

## Implementation Decisions

### Data Model

New and modified fields on the skills schema:

| Field               | Type           | Notes                                                   |
| ------------------- | -------------- | ------------------------------------------------------- |
| `id`                | string         | Per-version ULID (existing, unchanged)                  |
| `skillId`           | string         | **New.** Stable ULID across all versions and renames    |
| `namespace`         | string         | Required, "friday" for UI-created skills                |
| `name`              | string \| null | **Now nullable.** Null until user sets a title          |
| `title`             | string \| null | Display name (existing)                                 |
| `description`       | string         | Auto-generated from instructions unless manually set    |
| `descriptionManual` | boolean        | **New.** True if user explicitly edited the description |
| `instructions`      | string         | Markdown body (existing)                                |

A skill is **available** to agents when it has `name`, `description`, and
`instructions`. Otherwise it exists but isn't resolvable.

### API Changes

**New endpoint: `POST /api/skills`**

- Creates a blank skill record. No body required.
- Mints a `skillId` ULID, inserts with `name: null`, empty description and
  instructions.
- Returns `{ skillId }`.

**New endpoint: `GET /api/skills/:skillId`**

- Fetches latest version by `skillId`.
- Works regardless of skill availability status (name set or not).

**Modified: `GET /api/skills` (list)**

- New query param: `includeAll` (boolean, default `false`).
- `false` — only returns skills with a `name` (available skills, for agents).
- `true` — returns all skills including unnamed ones (for the web UI).

**Modified: `POST /api/skills/:namespace/:name` (publish)**

- Accepts `skillId` in JSON body to associate with an existing skill record.
- Accepts `descriptionManual` boolean — when false and instructions changed, the
  API generates a description via LLM before persisting.
- When `name` changes via slug edit, all versions with the same `skillId` get
  their `name` updated.

**Auto-description generation:**

- Triggered server-side in the publish route when `descriptionManual` is false
  and instructions are non-empty.
- Uses `smallLLM()` from `@atlas/llm` (Groq/Llama, fast and cheap) to generate
  a concise one-sentence description from the instructions content.
- Best-effort — if the LLM call fails, publish proceeds with empty description
  and logs a warning. Never blocks or errors the publish request.
- If the user clears a manual description back to empty, `descriptionManual`
  resets to false and auto-generation resumes on next publish.

### URL Structure

**Route: `/skills/[skillId]/[[namespace]]/[[name]]`**

SvelteKit optional params (`[[...]]`) make all of these valid:

- `/skills/01JXY...` — skill with no name yet
- `/skills/01JXY.../friday/my-skill` — skill with name

Only `skillId` is used for data fetching. The `namespace/name` segments are a
visual affordance — if stale (post-rename), the page loads and updates the URL
via SvelteKit `goto(url, { replaceState: true })` from `$app/navigation`.

### Detail Page Behavior

Single page handles both new and existing skills. No `/new` route.

**Fields:**

- **Title** — `Page.Title` with `onblur`. First meaningful title generates the
  slug via `toSlug()` and publishes. Subsequent title changes do NOT regenerate
  the slug.
- **Slug** — Editable field in sidebar (like description). Shown once a title
  has been set. Editing the slug directly is the only way to change the `name`
  after initial generation. Updates all versions under the same `skillId`.
- **Description** — Editable textarea in sidebar. Auto-populated by the API when
  instructions change (LLM-generated). Once the user manually edits it, the
  client sends `descriptionManual: true` and auto-generation stops.
- **Instructions** — `MarkdownEditor` with `onblur` triggering save.

**Auto-save triggers:**

- Title blur -> publish (generates slug on first title)
- Instructions blur -> publish (may trigger API-side description generation)
- Description blur -> publish (with `descriptionManual: true`)
- Slug blur -> publish (rename across all versions)
- `beforeNavigate` -> save if dirty (via SvelteKit `beforeNavigate`)

No `beforeunload` handler — only in-app navigation protection.

**URL updates:** All URL changes use SvelteKit's
`goto(url, { replaceState: true })` from `$app/navigation`. When slug is first
set or changed, the URL updates from `/skills/[skillId]` to
`/skills/[skillId]/friday/[slug]`.

### Listing Page

- Passes `includeAll=true` to show all skills.
- Skills with a name show `title ?? name` as the label.
- Skills without a name show "Untitled skill" in muted style.
- Row links go to `/skills/[skillId]/[namespace]/[name]` or `/skills/[skillId]`
  if no name.
- **Status column** — empty for available skills, shows "Needs attention" when
  `name` or `description` is missing.
- **"New Skill" button** — calls `POST /api/skills`, then
  `goto(/skills/[skillId])`.

### Navigation Flows

1. **Create:** Click "New Skill" -> `POST /api/skills` ->
   `goto(/skills/[skillId])`
2. **First title:** Type title, blur -> publish with generated slug ->
   `goto(/skills/[skillId]/friday/my-slug, { replaceState: true })`
3. **Rename slug:** Edit slug in sidebar, blur -> publish with new name ->
   `goto` updates trailing URL segments
4. **From list:** Click row -> `/skills/[skillId]/[namespace]/[name]`

## Testing Decisions

Tests should verify external behavior — API responses, URL state, and data
persistence — not implementation internals.

**Backend:**

- `packages/skills/tests/local-adapter.test.ts`:
  - Create skill with no name, verify `skillId` returned
  - Publish with `skillId`, verify versions share the same `skillId`
  - Rename via slug edit updates all versions with same `skillId`
  - `name: null` skills excluded from list when `includeAll` is false
  - `name: null` skills included when `includeAll` is true
  - `descriptionManual: false` triggers description generation
  - `descriptionManual: true` preserves user description
- `apps/atlasd/routes/skills.test.ts`:
  - `POST /api/skills` returns `skillId`
  - `GET /api/skills/:skillId` returns latest version
  - `GET /api/skills?includeAll=true` includes unnamed skills
  - `GET /api/skills` (default) excludes unnamed skills
  - Publish with changed slug renames all versions

**Prior art:** Existing tests in `packages/skills/tests/local-adapter.test.ts`
and `apps/atlasd/routes/skills.test.ts` follow the same pattern — publish,
fetch, assert on response shape.

### Storage Layer Changes (`packages/skills/src/`)

#### Schema changes (`schemas.ts`)

`name` becomes nullable across all schemas:

- `SkillSchema.name` — `SkillNameSchema` -> `SkillNameSchema.nullable()`
- `SkillSummarySchema.name` — `SkillNameSchema` -> `SkillNameSchema.nullable()`
- `SkillDbRowSchema.name` — `SkillNameSchema` -> `SkillNameSchema.nullable()`

New fields added to all schemas:

- `skillId: z.string()` — stable ULID
- `descriptionManual: z.boolean()` — in `SkillSchema`, `SkillDbRowSchema`

`PublishSkillInputSchema` changes:

- `description` becomes optional (auto-generated when missing)
- Add `skillId: z.string().optional()` — links to existing skill record
- Add `descriptionManual: z.boolean().optional()` — defaults to false

`SkillSummarySchema` adds:

- `skillId: z.string()`
- `name: SkillNameSchema.nullable()`

#### Database schema (`local-adapter.ts`)

New columns in CREATE TABLE:

```sql
skill_id TEXT NOT NULL,
description_manual INTEGER NOT NULL DEFAULT 0,
```

`name` column changes from `NOT NULL` to nullable:

```sql
name TEXT,  -- was: name TEXT NOT NULL
```

UNIQUE constraint changes — `skillId` groups versions, `name` is no longer part
of the version uniqueness since it can be null:

```sql
UNIQUE(skill_id, version)  -- was: UNIQUE(namespace, name, version)
```

Migration in `migrateIfNeeded()`:

- If `skill_id` column missing: add it, backfill existing rows with their `id`
  value (each existing skill becomes its own group)
- If `description_manual` column missing: add it with default 0

#### Adapter interface (`storage.ts`)

New methods on `SkillStorageAdapter`:

```typescript
create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>>;
getBySkillId(skillId: string): Promise<Result<Skill | null, string>>;
```

Modified methods:

```typescript
list(namespace?: string, query?: string, includeAll?: boolean):
  Promise<Result<SkillSummary[], string>>;

publish(namespace: string, name: string, createdBy: string, input: PublishSkillInput):
  Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>>;
```

#### List query changes (`local-adapter.ts`)

The `list()` method gains an `includeAll` parameter. The current query groups by
`(namespace, name)` which breaks with null names — multiple unnamed skills would
collapse into one row. The query changes to group by `skill_id` instead:

```sql
SELECT s.id, s.skill_id, s.namespace, s.name, s.title, s.description,
       s.version as latestVersion
FROM skills s
INNER JOIN (
  SELECT skill_id, MAX(version) as max_version
  FROM skills
  GROUP BY skill_id
) latest ON s.skill_id = latest.skill_id AND s.version = latest.max_version
```

When `includeAll` is false (default), add:

```sql
WHERE s.name IS NOT NULL AND s.description != ''
```

This ensures agents only see fully available skills. The web UI passes
`includeAll=true` to see everything.

#### `getBySkillId` query

```sql
SELECT * FROM skills WHERE skill_id = ? ORDER BY version DESC LIMIT 1
```

Returns the latest version regardless of name/description status.

#### `create` method

Inserts a minimal row with `name: null`, empty description/instructions, version
1:

```sql
INSERT INTO skills (id, skill_id, namespace, name, version, title,
  description, description_manual, frontmatter, instructions, archive,
  created_by, created_at)
VALUES (?, ?, ?, NULL, 1, NULL, '', 0, '{}', '', NULL, ?, ?)
```

#### `publish` method changes

- Accepts `skillId` in input to associate with existing skill record
- Uses `skill_id` instead of `(namespace, name)` for version numbering:
  `SELECT MAX(version) FROM skills WHERE skill_id = ?`
- When `name` changes (slug edit), updates all rows with same `skill_id`:
  `UPDATE skills SET name = ? WHERE skill_id = ?`
- Returns `skillId` in result

## Out of Scope

- Skill deletion UI
- Version history UI
- Assets and references sections (behind feature flags)
- Skill search/filtering
- Multi-namespace support
- Skill sharing
- Archive/file upload
- Cortex adapter changes (local adapter only for now)

## Further Notes

- The `toSlug()` utility is duplicated client-side
  (`apps/web-client/src/lib/utils/slug.ts`) and server-side
  (`packages/skills/src/slug.ts`). The function is deterministic and trivial, so
  duplication is acceptable. The server is the source of truth.
- `skillId` uses nanoid (16-char lowercase alphanumeric, e.g. `v3xk7mq9p2rj4a8b`)
  for URL-friendly IDs. Per-version `id` remains ULID.
- The `friday` namespace is hardcoded for UI-created skills. No `@` prefix in
  URLs (`/friday/slug` not `/@friday/slug`).
- The existing `GET /api/skills/:namespace/:name` endpoint remains for agent
  resolution by name. The new `GET /api/skills/:skillId` is for UI use.
