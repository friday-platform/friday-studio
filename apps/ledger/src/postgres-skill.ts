import type { ResourceToolName } from "./sqlite-skill.ts";

interface ToolEntry {
  name: ResourceToolName;
  signature: string;
  description: string;
}

interface CriticalRule {
  text: string;
  /** Tool names that must be present for this rule to be included. If empty, always included. */
  requiredTools: ResourceToolName[];
}

const POSTGRES_TOOLS: ToolEntry[] = [
  {
    name: "resource_read",
    signature: "resource_read(slug, query, params?)",
    description: "read-only query",
  },
  {
    name: "resource_write",
    signature: "resource_write(slug, query, params?)",
    description: "mutate the draft (must return exactly one value — the new `data`)",
  },
  {
    name: "resource_save",
    signature: "resource_save(slug)",
    description: "publish draft as new version",
  },
  {
    name: "resource_link_ref",
    signature: "resource_link_ref(slug, ref)",
    description: "set URL/ID on an external_ref resource",
  },
];

const POSTGRES_CRITICAL_RULES: CriticalRule[] = [
  {
    text: "**resource_write must return exactly one value** — the new `data`. Always `SELECT ... FROM draft`.",
    requiredTools: ["resource_write"],
  },
  {
    text: "**jsonb_agg()** to reassemble arrays from jsonb_array_elements iteration.",
    requiredTools: [],
  },
  {
    text: "**jsonb_build_object()** to construct objects — string concatenation produces malformed JSON with special characters.",
    requiredTools: [],
  },
  {
    text: "**$1, $2... params** for user-provided text — interpolation enables SQL injection.",
    requiredTools: [],
  },
  {
    text: "**artifact_ref and external_ref** are read-only via resource_write — use resource_link_ref instead.",
    requiredTools: ["resource_write", "resource_link_ref"],
  },
];

/**
 * Builds dialect-specific Postgres skill text for agent prompt injection.
 *
 * @param availableTools - When provided and non-empty, only includes listed tools
 *   and their related critical rules. Undefined or empty array returns full text.
 */
export function buildPostgresSkillText(availableTools?: readonly string[]): string {
  const tools =
    availableTools && availableTools.length > 0
      ? POSTGRES_TOOLS.filter((t) => availableTools.includes(t.name))
      : POSTGRES_TOOLS;

  const toolSet = new Set(tools.map((t) => t.name));

  const rules =
    availableTools && availableTools.length > 0
      ? POSTGRES_CRITICAL_RULES.filter(
          (r) => r.requiredTools.length === 0 || r.requiredTools.every((t) => toolSet.has(t)),
        )
      : POSTGRES_CRITICAL_RULES;

  const toolCount = ["One", "Two", "Three", "Four"][tools.length - 1] ?? String(tools.length);
  const toolWord = tools.length === 1 ? "tool" : "tools";
  const toolLines = tools.map((t) => `- **${t.signature}** — ${t.description}`).join("\n");

  const ruleLines = rules.map((r) => `- ${r.text}`).join("\n");

  const hasWrite = toolSet.has("resource_write");
  const hasSave = toolSet.has("resource_save");

  const writeNote = hasWrite
    ? `\nresource_write takes a SELECT that returns the **new value** for \`data\`. The Ledger replaces the entire \`data\` column with your result — write as SELECT, not INSERT/UPDATE, and always include \`FROM draft\` to build on the current state.\n`
    : "";

  const writingPatterns = hasWrite
    ? `
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
`
    : "";

  const gotchas = hasWrite
    ? `## Gotchas

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

**jsonb_agg returns NULL on empty input:** When all rows are filtered out, jsonb_agg returns SQL NULL. Use \`COALESCE(jsonb_agg(elem), '[]'::jsonb)\` for safe empty array.`
    : `## Gotchas

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

**jsonb_agg returns NULL on empty input:** When all rows are filtered out, jsonb_agg returns SQL NULL. Use \`COALESCE(jsonb_agg(elem), '[]'::jsonb)\` for safe empty array.`;

  return `<resource_sql_skill>
# Resource Data Access (Postgres)

## Contract

Your SQL runs against a CTE called \`draft\` (provided automatically) with two columns: \`data\` (JSONB — the resource content: array, object, or string) and \`schema\` (JSONB — JSON Schema describing the shape).

${toolCount} ${toolWord}:
${toolLines}
${writeNote}
## Schema Discovery

Inspect the data shape before writing queries:
\`\`\`sql
SELECT draft.schema FROM draft
\`\`\`

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
${writingPatterns}
## Critical Rules

${ruleLines}

${gotchas}
${
  hasSave
    ? `
## Draft/Publish Lifecycle

- Resources start with a draft and version 1 (created at provision time).
- resource_write modifies the draft. Changes are immediately readable via resource_read.
- resource_save publishes the draft as a new immutable version. No-op if nothing changed.
- Auto-publish at end of each agent turn — call resource_save only for mid-turn checkpoints.`
    : ""
}
</resource_sql_skill>
`;
}

/** Postgres JSONB skill text. Full text with all tools. */
export const POSTGRES_SKILL_TEXT = buildPostgresSkillText();
