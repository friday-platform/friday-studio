/** SQLite JSONB skill text. Served at GET /v1/skill and injected into agent prompts. */
export const SQLITE_SKILL_TEXT = `# Resource Data Access (SQLite)

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

Iterate with json_each, extract fields with json_extract:
\`\`\`sql
SELECT json_extract(j.value, '$.name') as name,
       json_extract(j.value, '$.quantity') as qty
FROM draft, json_each(draft.data) j
WHERE json_extract(j.value, '$.quantity') > 5
\`\`\`

Aggregate:
\`\`\`sql
SELECT json_extract(j.value, '$.category') as category, count(*) as n
FROM draft, json_each(draft.data) j
GROUP BY category
\`\`\`

Count without iteration:
\`\`\`sql
SELECT json_array_length(draft.data) as total FROM draft
\`\`\`

### Prose (data is a string)

\`\`\`sql
SELECT draft.data FROM draft
\`\`\`

### Document (hierarchical — data is an object with nested arrays/objects)

Extract top-level fields:
\`\`\`sql
SELECT json_extract(draft.data, '$.title') as title,
       json_extract(draft.data, '$.meeting_date') as date
FROM draft
\`\`\`

Iterate nested arrays:
\`\`\`sql
SELECT json_extract(item.value, '$.task') as task,
       json_extract(item.value, '$.assignee') as assignee
FROM draft, json_each(json_extract(draft.data, '$.action_items')) item
WHERE json_extract(item.value, '$.done') = 0
\`\`\`

## Writing Patterns

### Tabular: append one row

\`\`\`sql
SELECT json_insert(draft.data, '$[#]',
  json_object('item', 'eggs', 'quantity', 12))
FROM draft
\`\`\`

### Tabular: append multiple rows

\`\`\`sql
SELECT json_group_array(combined.value)
FROM (
  SELECT j.value FROM draft, json_each(draft.data) j
  UNION ALL
  SELECT json_object('item', 'milk', 'quantity', 2)
  UNION ALL
  SELECT json_object('item', 'bread', 'quantity', 1)
) combined
\`\`\`

### Tabular: update one field

\`\`\`sql
SELECT json_group_array(
  CASE WHEN json_extract(j.value, '$.item') = 'eggs'
    THEN json_set(j.value, '$.quantity', 24)
    ELSE j.value END)
FROM draft, json_each(draft.data) j
\`\`\`

### Tabular: remove rows by filter

Keep matching rows — non-matching rows are removed:
\`\`\`sql
SELECT json_group_array(j.value)
FROM draft, json_each(draft.data) j
WHERE json_extract(j.value, '$.category') != 'dairy'
\`\`\`

### Prose: replace content

Use parameter binding:
\`\`\`sql
SELECT $1 FROM draft
\`\`\`
Pass new content as \`params: ["# New Title\\n\\nContent..."]\`

### Document (hierarchical): append to nested array

\`\`\`sql
SELECT json_insert(draft.data, '$.action_items[#]',
  json_object('task', 'Review PR', 'assignee', 'Alice', 'done', json('false')))
FROM draft
\`\`\`

### Document (hierarchical): update element in nested array

Rebuild the nested array via json_each + CASE, then json_set it back:
\`\`\`sql
SELECT json_set(draft.data, '$.action_items',
  (SELECT json_group_array(
    CASE WHEN json_extract(item.value, '$.assignee') = 'Alice'
              AND json_extract(item.value, '$.task') = 'finalize schema'
      THEN json_set(item.value, '$.done', json('true'))
      ELSE item.value END)
   FROM json_each(json_extract(draft.data, '$.action_items')) item))
FROM draft
\`\`\`

## Critical Rules

1. **resource_write must return exactly one value** — the new \`data\`. Always \`SELECT ... FROM draft\`.
2. **json_group_array()** to reassemble arrays from json_each iteration.
3. **json_object()** to construct objects — never string-concatenate JSON.
4. **$1, $2... params** for user-provided text — never interpolate strings into SQL.
5. **artifact_ref and external_ref** are read-only via resource_write — use resource_link_ref instead.

## Gotchas

**Value-as-literal (most common bug):** json_set stores raw values as-is. Booleans and nested JSON need the json() wrapper:
\`\`\`sql
-- WRONG: stores the string "true", not the boolean true
json_set(j.value, '$.done', 'true')
-- RIGHT: stores the boolean true
json_set(j.value, '$.done', json('true'))
\`\`\`
Same for arrays/objects: \`json_set(obj, '$.tags', json('[1,2,3]'))\`. Numbers and NULL work as-is.

**Empty result from json_each:** Data might be an object, not an array. Check: \`SELECT typeof(draft.data) FROM draft\`.

**NULL from json_extract:** Wrong path or case mismatch. Check schema: \`SELECT draft.schema FROM draft\`.

**json_group_array returns ["null"]:** WHERE filtered all rows. Return empty array: \`SELECT json_array() FROM draft\`.

**Type mismatch in comparisons:** json_extract returns TEXT by default. Cast for numeric ops: \`CAST(json_extract(j.value, '$.age') AS INTEGER) > 18\`.

## Draft/Publish Lifecycle

- Resources start with a draft and version 1 (created at provision time).
- resource_write modifies the draft. Changes are immediately readable via resource_read.
- resource_save publishes the draft as a new immutable version. No-op if nothing changed.
- Auto-publish at end of each agent turn — call resource_save only for mid-turn checkpoints.
`;
