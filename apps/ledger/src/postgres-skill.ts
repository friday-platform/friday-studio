/** Postgres JSONB skill text. Served at GET /v1/skill when Postgres adapter is active. */
export const POSTGRES_SKILL_TEXT = `# Resource Data Access (Postgres)

## Contract

Your SQL runs against a CTE called \`draft\` (provided automatically) with two columns: \`data\` (JSONB — the resource content: array, object, or string) and \`schema\` (JSONB — JSON Schema describing the shape).

Four tools:
- **resource_read(slug, query, params?)** — read-only query
- **resource_write(slug, query, params?)** — mutate the draft (must return exactly one value — the new \`data\`)
- **resource_save(slug)** — publish draft as new version
- **resource_link_ref(slug, ref)** — set URL/ID on an external_ref resource

resource_write takes a SELECT that returns the **new value** for \`data\`. Write as SELECT, not INSERT/UPDATE.

## Reading Patterns

### Tabular (data is a JSON array of objects)

Iterate with jsonb_array_elements, extract fields with ->>. Count with \`jsonb_array_length(draft.data)\`.
\`\`\`sql
SELECT elem->>'name' AS name,
       (elem->>'quantity')::int AS qty
FROM draft, jsonb_array_elements(draft.data) elem
WHERE (elem->>'quantity')::int > 5
\`\`\`

### Document (hierarchical — data is an object with nested arrays/objects)

Extract top-level fields with \`draft.data->>'field'\`. Iterate nested arrays:
\`\`\`sql
SELECT item->>'task' AS task,
       item->>'assignee' AS assignee
FROM draft, jsonb_array_elements(draft.data->'action_items') item
WHERE (item->>'done')::boolean = false
\`\`\`

### Prose (data is a string)

\`SELECT draft.data FROM draft\`

## Writing Patterns

### Tabular: append

\`\`\`sql
SELECT draft.data || jsonb_build_array(
  jsonb_build_object('item', 'eggs', 'quantity', 12))
FROM draft
\`\`\`

### Tabular: update

\`\`\`sql
SELECT jsonb_agg(
  CASE WHEN elem->>'item' = 'eggs'
    THEN jsonb_set(elem, '{quantity}', '24')
    ELSE elem END)
FROM draft, jsonb_array_elements(draft.data) elem
\`\`\`

### Tabular: remove by filter

\`\`\`sql
SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
FROM draft, jsonb_array_elements(draft.data) elem
WHERE elem->>'category' != 'dairy'
\`\`\`

### Prose: replace content

\`SELECT $1 FROM draft\` with \`params: ["# New Title\\n\\nContent..."]\`.

### Document (hierarchical): append to nested array

\`\`\`sql
SELECT jsonb_set(draft.data, '{action_items}',
  (draft.data->'action_items') || jsonb_build_array(
    jsonb_build_object('task', 'Review PR', 'assignee', 'Alice', 'done', false)))
FROM draft
\`\`\`

### Document (hierarchical): update element in nested array

Rebuild via jsonb_array_elements + CASE, then jsonb_set back:
\`\`\`sql
SELECT jsonb_set(draft.data, '{action_items}',
  (SELECT jsonb_agg(
    CASE WHEN item->>'assignee' = 'Alice'
              AND item->>'task' = 'finalize schema'
      THEN jsonb_set(item, '{done}', 'true')
      ELSE item END)
   FROM jsonb_array_elements(draft.data->'action_items') item))
FROM draft
\`\`\`

## Critical Rules

1. **resource_write must return exactly one value** — the new \`data\`. Always \`SELECT ... FROM draft\`.
2. **jsonb_agg()** to reassemble arrays from jsonb_array_elements iteration.
3. **jsonb_build_object()** to construct objects — never string-concatenate JSON.
4. **$1, $2... params** for user-provided text — never interpolate strings into SQL.
5. **artifact_ref and external_ref** are read-only via resource_write — use resource_link_ref instead.

## Gotchas

**->> vs -> (most common bug):** \`->>\` extracts as text, \`->\` extracts as jsonb. Use \`->>\` for comparisons and display, \`->\` when you need to pass the value to another JSONB function:
\`\`\`sql
-- WRONG: -> returns jsonb, comparison with text fails
WHERE elem->'status' = 'active'
-- RIGHT: ->> returns text
WHERE elem->>'status' = 'active'
-- RIGHT: -> when feeding into jsonb_array_elements or jsonb_set
jsonb_array_elements(draft.data->'items')
\`\`\`

**Casting:** \`->>\` always returns text. Cast for numeric/boolean: \`(elem->>'quantity')::int > 5\`, \`(elem->>'done')::boolean = false\`.

**jsonb_agg returns NULL on empty input:** When all rows are filtered out, jsonb_agg returns SQL NULL. Use \`COALESCE(jsonb_agg(elem), '[]'::jsonb)\` for safe empty array.

## Draft/Publish Lifecycle

- Resources start with a draft and version 1 (created at provision time).
- resource_write modifies the draft. Changes are immediately readable via resource_read.
- resource_save publishes the draft as a new immutable version. No-op if nothing changed.
- Auto-publish at end of each agent turn — call resource_save only for mid-turn checkpoints.
`;
