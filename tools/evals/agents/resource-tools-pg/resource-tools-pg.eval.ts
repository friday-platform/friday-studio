/**
 * Resource Tools (Postgres) — JSONB query generation eval.
 *
 * Tests skill document effectiveness: given the Postgres adapter skill text,
 * a resource schema, and a natural language task, can an LLM generate
 * syntactically correct and semantically valid JSONB queries?
 *
 * Each case:
 * 1. Sends the skill doc + schema + task to an LLM via generateText
 * 2. Extracts SQL from the response
 * 3. Executes it against an in-process PGlite database with a `draft` CTE
 * 4. Scores: sql-valid (executes without error), result-correct (matches expected)
 *
 * Ground truth values computed independently via Postgres JSONB functions.
 */

import { registry, traceModel } from "@atlas/llm";
import { PGlite } from "@electric-sql/pglite";
import { assertEquals } from "@std/assert";
import { generateText } from "ai";
import { POSTGRES_SKILL_TEXT } from "../../../../apps/ledger/src/postgres-skill.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();
const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Test data — grocery list (tabular)
// ---------------------------------------------------------------------------

const GROCERY_SCHEMA = JSON.stringify({
  type: "array",
  items: {
    type: "object",
    properties: {
      item: { type: "string" },
      quantity: { type: "integer" },
      category: { type: "string" },
      price: { type: "number" },
    },
    required: ["item", "quantity", "category", "price"],
  },
});

const GROCERY_DATA = JSON.stringify([
  { item: "eggs", quantity: 12, category: "dairy", price: 4.99 },
  { item: "milk", quantity: 2, category: "dairy", price: 3.49 },
  { item: "bread", quantity: 1, category: "bakery", price: 2.99 },
  { item: "apples", quantity: 6, category: "produce", price: 5.49 },
  { item: "chicken", quantity: 2, category: "meat", price: 12.99 },
  { item: "rice", quantity: 1, category: "pantry", price: 3.99 },
  { item: "butter", quantity: 1, category: "dairy", price: 4.49 },
  { item: "onions", quantity: 3, category: "produce", price: 1.99 },
]);

// ---------------------------------------------------------------------------
// Test data — meeting notes (prose)
// ---------------------------------------------------------------------------

const PROSE_SCHEMA = JSON.stringify({ type: "string" });
const PROSE_DATA = JSON.stringify(
  "# Sprint Planning\n\nDate: 2026-02-20\n\n## Decisions\n- Ship v2 API by Friday\n- Defer billing migration to next sprint\n\n## Action Items\n- Alice: finalize schema changes\n- Bob: update integration tests",
);

// ---------------------------------------------------------------------------
// Test data — meeting record (nested object)
// ---------------------------------------------------------------------------

const MEETING_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    meeting_date: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          assignee: { type: "string" },
          done: { type: "boolean" },
        },
        required: ["task", "assignee", "done"],
      },
    },
  },
  required: ["title", "meeting_date", "attendees", "action_items"],
});

const MEETING_DATA = JSON.stringify({
  title: "Sprint Planning",
  meeting_date: "2026-02-20",
  attendees: ["Alice", "Bob", "Charlie"],
  action_items: [
    { task: "finalize schema", assignee: "Alice", done: true },
    { task: "update integration tests", assignee: "Bob", done: false },
    { task: "deploy staging", assignee: "Alice", done: true },
    { task: "write migration guide", assignee: "Charlie", done: false },
  ],
});

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an agent that works with workspace resources using SQL queries against a JSONB-backed Postgres database.

${POSTGRES_SKILL_TEXT}

When asked to perform an operation on a resource, respond with ONLY the SQL query inside a single code block. No explanation, no commentary — just the SQL.

For read operations, use resource_read queries (SELECT that reads data).
For write operations, use resource_write queries (SELECT that returns the new data value).

If the task requires parameters (like prose content), also output the params as a JSON array on a separate line prefixed with "PARAMS: ".

IMPORTANT: Parameters start at $2 because $1 is reserved internally.`;

/**
 * @description Extracts the first column value from a single-row query result.
 * PGlite auto-parses JSONB columns, so values are already native JS types.
 */
function extractResultValue(row: Record<string, unknown>): unknown {
  const val = Object.values(row)[0];
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as unknown;
    } catch {
      return val;
    }
  }
  return val;
}

/**
 * @description Extracts the first SQL code block from LLM response text.
 * Falls back to treating the entire response as SQL if no code block found.
 */
function extractSQL(response: string): {
  sql: string;
  params: (string | number | boolean | null)[];
} {
  const codeBlockMatch = response.match(/```(?:sql)?\s*\n?([\s\S]*?)```/);
  const sql = codeBlockMatch?.[1]?.trim() ?? response.trim();

  const paramsMatch = response.match(/PARAMS:\s*(\[.*\])/);
  const params: (string | number | boolean | null)[] = paramsMatch?.[1]
    ? (JSON.parse(paramsMatch[1]) as (string | number | boolean | null)[])
    : [];

  return { sql, params };
}

/**
 * @description Executes SQL against an in-process PGlite database with
 * a `draft` CTE pre-populated with the given test data and schema.
 *
 * The real adapter reserves $1 for resource_id and agent params start at $2.
 * Here the CTE reads from _draft_seed (no $1 needed), so we build a bind
 * array sized to the highest $N reference in the SQL, with user params
 * placed at their expected positions.
 */
async function executeDraftQuery(
  sql: string,
  params: (string | number | boolean | null)[],
  data: string,
  schema: string,
): Promise<{ rows: unknown[]; error: string | null }> {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE _draft_seed (data JSONB NOT NULL, schema JSONB NOT NULL)`);
    await db.query(`INSERT INTO _draft_seed (data, schema) VALUES ($1::jsonb, $2::jsonb)`, [
      data,
      schema,
    ]);

    // Agent SQL uses $2+ (since $1 is reserved for resource_id in production).
    // Renumber $N → $N-1 so we can pass user params directly without a $1 placeholder.
    // Postgres rejects untyped unreferenced params, so we can't just pass null for $1.
    const renumbered = sql.replace(/\$(\d+)/g, (_match, num) => `$${parseInt(num, 10) - 1}`);
    const fullSQL = `WITH draft AS (SELECT data, schema FROM _draft_seed) ${renumbered}`;

    const result = await db.query(fullSQL, params);
    return { rows: result.rows as unknown[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.close();
  }
}

/**
 * @description Asks the LLM to generate Postgres SQL for a resource task.
 */
async function generateSQL(
  task: string,
  schema: string,
  dataDescription: string,
): Promise<{ text: string; sql: string; params: (string | number | boolean | null)[] }> {
  const { text } = await generateText({
    model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-20250514")),
    system: SYSTEM_PROMPT,
    prompt: `Resource schema:\n${schema}\n\nCurrent data description: ${dataDescription}\n\nTask: ${task}`,
    maxOutputTokens: 1000,
  });

  const { sql, params } = extractSQL(text);
  return { text, sql, params };
}

// ---------------------------------------------------------------------------
// Case definition
// ---------------------------------------------------------------------------

interface ResourceToolCase extends Omit<BaseEvalCase, "input"> {
  task: string;
  schema: string;
  seedData: string;
  dataDescription: string;
  isWrite: boolean;
  assertResult: (rows: unknown[]) => void;
  scoreResult: (result: { rows: unknown[]; error: string | null; sql: string }) => Score[];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: ResourceToolCase[] = [
  // === Tabular reads ===
  {
    id: "tabular-read-all",
    name: "tabular read - all rows",
    task: "Read all items from the grocery list resource.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: false,
    assertResult: (rows) => {
      assertEquals(rows.length, 8, `Expected 8 rows, got ${rows.length}`);
    },
    scoreResult: ({ rows, error }) => [
      createScore("sql-valid", error === null ? 1 : 0, error ?? "executed successfully"),
      createScore("result-correct", rows.length === 8 ? 1 : 0, `${rows.length}/8 rows`),
    ],
  },
  {
    id: "tabular-read-filter",
    name: "tabular read - filter by quantity",
    task: "Show me all grocery items where the quantity is greater than 2.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: false,
    assertResult: (rows) => {
      // eggs(12), apples(6), onions(3) = 3 items with quantity > 2
      assertEquals(rows.length, 3, `Expected 3 rows with quantity > 2, got ${rows.length}`);
    },
    scoreResult: ({ rows, error }) => [
      createScore("sql-valid", error === null ? 1 : 0, error ?? "executed successfully"),
      createScore("result-correct", rows.length === 3 ? 1 : 0, `${rows.length}/3 rows`),
    ],
  },
  {
    id: "tabular-read-aggregate",
    name: "tabular read - sum prices",
    task: "What is the sum of all price values on the grocery list? Just add up the price field for every item.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: false,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Expected 1 aggregate row");
      const row = rows[0] as Record<string, unknown>;
      const total = Number(Object.values(row)[0]);
      // 4.99 + 3.49 + 2.99 + 5.49 + 12.99 + 3.99 + 4.49 + 1.99 = 40.42
      const diff = Math.abs(total - 40.42);
      assertEquals(diff < 0.01, true, `Expected total ~40.42, got ${total}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      const total = row ? Number(Object.values(row)[0]) : 0;
      const correct = Math.abs(total - 40.42) < 0.01;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore("result-correct", correct ? 1 : 0, `got ${total}, expected ~40.42`),
      ];
    },
  },
  {
    id: "tabular-read-group-by",
    name: "tabular read - group by category",
    task: "How many items are in each category?",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items across multiple categories, each having item, quantity, category, and price fields.",
    isWrite: false,
    assertResult: (rows) => {
      // 5 categories: dairy, produce, bakery, meat, pantry
      assertEquals(rows.length, 5, `Expected 5 category groups, got ${rows.length}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const dairyRow = rows.find((r) => {
        const values = Object.values(r as Record<string, unknown>);
        return values.some((v) => typeof v === "string" && v.toLowerCase() === "dairy");
      }) as Record<string, unknown> | undefined;
      const dairyCount = dairyRow
        ? Object.values(dairyRow).find((v) => typeof v === "number" && v === 3)
        : undefined;
      // PGlite may return bigint for count(*) — check both
      const dairyCountBigint = dairyRow
        ? Object.values(dairyRow).find(
            (v) => (typeof v === "bigint" && v === 3n) || (typeof v === "number" && v === 3),
          )
        : undefined;
      const found = dairyCount !== undefined || dairyCountBigint !== undefined;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          rows.length === 5 && found ? 1 : rows.length === 5 ? 0.5 : 0,
          `${rows.length} groups, dairy count=${dairyCount ?? dairyCountBigint ?? "not found"}`,
        ),
      ];
    },
  },

  // === Tabular writes ===
  {
    id: "tabular-append",
    name: "tabular write - append row",
    task: 'Add "bananas" (quantity 5, category "produce", price 2.49) to the grocery list.',
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row (the new data)");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as unknown[];
      assertEquals(newData.length, 9, `Expected 9 items after append, got ${newData.length}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      if (rows.length !== 1) {
        return [
          createScore("sql-valid", 1),
          createScore("result-correct", 0, `Expected 1 result row, got ${rows.length}`),
        ];
      }
      const row = rows[0] as Record<string, unknown>;
      const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
      const hasBananas = parsed.some((item) => (item.item as string)?.toLowerCase() === "bananas");
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          parsed.length === 9 && hasBananas ? 1 : parsed.length === 9 ? 0.5 : 0,
          `${parsed.length} items, bananas=${hasBananas}`,
        ),
      ];
    },
  },
  {
    id: "tabular-update",
    name: "tabular write - update field",
    task: "Update the quantity of eggs to 24.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as Array<Record<string, unknown>>;
      assertEquals(newData.length, 8, `Expected 8 items (unchanged count), got ${newData.length}`);
      const eggs = newData.find((i) => i.item === "eggs");
      assertEquals(eggs?.quantity, 24, `Expected eggs quantity=24, got ${eggs?.quantity}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
      const eggs = parsed.find((i) => i.item === "eggs");
      const correct = parsed.length === 8 && eggs?.quantity === 24;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          correct ? 1 : eggs?.quantity === 24 ? 0.5 : 0,
          `items=${parsed.length}, eggs.quantity=${eggs?.quantity}`,
        ),
      ];
    },
  },
  {
    id: "tabular-remove",
    name: "tabular write - remove rows by filter",
    task: "Remove all items in the dairy category from the grocery list.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields. 3 items are in the dairy category.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as Array<Record<string, unknown>>;
      // Remove 3 dairy items (eggs, milk, butter) -> 5 remaining
      assertEquals(
        newData.length,
        5,
        `Expected 5 items after removing dairy, got ${newData.length}`,
      );
      const hasDairy = newData.some((i) => i.category === "dairy");
      assertEquals(hasDairy, false, "Should have no dairy items");
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
      const hasDairy = parsed.some((i) => i.category === "dairy");
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          parsed.length === 5 && !hasDairy ? 1 : !hasDairy ? 0.5 : 0,
          `items=${parsed.length}, hasDairy=${hasDairy}`,
        ),
      ];
    },
  },

  // === Tabular edge cases ===
  {
    id: "tabular-multi-field-update",
    name: "tabular write - update multiple fields",
    task: "Update eggs: set quantity to 24 and price to 6.99.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with 8 items, each having item, quantity, category, and price fields.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as Array<Record<string, unknown>>;
      assertEquals(newData.length, 8, `Expected 8 items, got ${newData.length}`);
      const eggs = newData.find((i) => i.item === "eggs");
      assertEquals(eggs?.quantity, 24, `Expected eggs quantity=24, got ${eggs?.quantity}`);
      assertEquals(eggs?.price, 6.99, `Expected eggs price=6.99, got ${eggs?.price}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
      const eggs = parsed.find((i) => i.item === "eggs");
      const qtyOk = eggs?.quantity === 24;
      const priceOk = eggs?.price === 6.99;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          qtyOk && priceOk ? 1 : qtyOk || priceOk ? 0.5 : 0,
          `eggs.quantity=${eggs?.quantity}, eggs.price=${eggs?.price}`,
        ),
      ];
    },
  },
  {
    id: "tabular-count",
    name: "tabular read - count items",
    task: "How many items are on the grocery list?",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription:
      "A grocery list with items, each having item, quantity, category, and price fields.",
    isWrite: false,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Expected 1 row");
      const row = rows[0] as Record<string, unknown>;
      const count = Number(Object.values(row)[0]);
      assertEquals(count, 8, `Expected 8, got ${count}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      const count = row ? Number(Object.values(row)[0]) : 0;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore("result-correct", count === 8 ? 1 : 0, `got ${count}, expected 8`),
      ];
    },
  },

  // === Document (hierarchical) reads ===
  {
    id: "document-nested-read-fields",
    name: "document (hierarchical) read - extract top-level fields",
    task: "What is the meeting title and date?",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: "A meeting record with title, date, attendees, and action items.",
    isWrite: false,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Expected 1 row");
      const row = rows[0] as Record<string, unknown>;
      const values = Object.values(row);
      const hasTitle = values.some((v) => v === "Sprint Planning");
      const hasDate = values.some((v) => v === "2026-02-20");
      assertEquals(hasTitle, true, "Should contain title");
      assertEquals(hasDate, true, "Should contain date");
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const values = Object.values(row);
      const hasTitle = values.some((v) => v === "Sprint Planning");
      const hasDate = values.some((v) => v === "2026-02-20");
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          hasTitle && hasDate ? 1 : hasTitle || hasDate ? 0.5 : 0,
          `title=${hasTitle}, date=${hasDate}`,
        ),
      ];
    },
  },
  {
    id: "document-nested-read-iterate",
    name: "document (hierarchical) read - iterate nested array with filter",
    task: "List all action items that are not done yet.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: "A meeting record with title, date, attendees, and action items.",
    isWrite: false,
    assertResult: (rows) => {
      // "update integration tests" (Bob, done=false), "write migration guide" (Charlie, done=false)
      assertEquals(rows.length, 2, `Expected 2 undone items, got ${rows.length}`);
    },
    scoreResult: ({ rows, error }) => [
      createScore("sql-valid", error === null ? 1 : 0, error ?? "executed successfully"),
      createScore("result-correct", rows.length === 2 ? 1 : 0, `${rows.length}/2 undone items`),
    ],
  },

  // === Document (hierarchical) writes ===
  {
    id: "document-nested-write-update",
    name: "document (hierarchical) write - update element in nested array",
    task: "Mark Alice's 'finalize schema' action item as done.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: "A meeting record with title, date, attendees, and action items.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as Record<string, unknown>;
      const items = newData.action_items as Array<Record<string, unknown>>;
      const target = items.find((i) => i.task === "finalize schema" && i.assignee === "Alice");
      assertEquals(target?.done, true, `Expected done=true, got ${target?.done}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const newData = extractResultValue(row) as Record<string, unknown>;
      const items = newData.action_items as Array<Record<string, unknown>> | undefined;
      if (!items) {
        return [
          createScore("sql-valid", 1),
          createScore("result-correct", 0, "no action_items in result"),
        ];
      }
      const target = items.find((i) => i.task === "finalize schema" && i.assignee === "Alice");
      const othersDone = items.filter(
        (i) => !(i.task === "finalize schema" && i.assignee === "Alice"),
      );
      const othersUnchanged = othersDone.length === 3;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          target?.done === true && othersUnchanged ? 1 : target?.done === true ? 0.5 : 0,
          `target.done=${target?.done}, othersCount=${othersDone.length}`,
        ),
      ];
    },
  },
  {
    id: "document-nested-write-append",
    name: "document (hierarchical) write - append to nested array",
    task: "Add a new action item: task 'Write docs', assignee 'Charlie', done false.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: "A meeting record with title, date, attendees, and 4 action items.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const newData = extractResultValue(row) as Record<string, unknown>;
      const items = newData.action_items as Array<Record<string, unknown>>;
      assertEquals(items.length, 5, `Expected 5 action items after append, got ${items.length}`);
      const added = items.find((i) => i.task === "Write docs");
      assertEquals(added?.assignee, "Charlie", `Expected assignee Charlie, got ${added?.assignee}`);
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return [createScore("sql-valid", 1), createScore("result-correct", 0, "no result row")];
      }
      const newData = extractResultValue(row) as Record<string, unknown>;
      const items = newData.action_items as Array<Record<string, unknown>> | undefined;
      if (!items) {
        return [
          createScore("sql-valid", 1),
          createScore("result-correct", 0, "no action_items in result"),
        ];
      }
      const added = items.find((i) => i.task === "Write docs");
      const countOk = items.length === 5;
      const contentOk = added?.assignee === "Charlie" && added?.done === false;
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          countOk && contentOk ? 1 : countOk || contentOk ? 0.5 : 0,
          `items=${items.length}, added=${JSON.stringify(added)}`,
        ),
      ];
    },
  },

  // === Prose ===
  {
    id: "prose-read",
    name: "prose read - full content",
    task: "Read the full content of the meeting notes.",
    schema: PROSE_SCHEMA,
    seedData: PROSE_DATA,
    dataDescription: "Sprint planning meeting notes as a markdown string.",
    isWrite: false,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Expected 1 row for prose read");
      const row = rows[0] as Record<string, unknown>;
      const data = String(Object.values(row)[0]);
      assertEquals(data.includes("Sprint Planning"), true, "Should contain meeting title");
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      const data = row ? String(Object.values(row)[0]) : "";
      const hasContent = data.includes("Sprint Planning");
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          hasContent ? 1 : 0,
          hasContent ? "contains meeting title" : `got: ${data.slice(0, 100)}`,
        ),
      ];
    },
  },
  {
    id: "prose-write",
    name: "prose write - replace content",
    task: 'Replace the meeting notes with: "# Retrospective\\n\\nDate: 2026-02-27\\n\\n## What went well\\n- Shipped on time\\n\\n## What to improve\\n- Better test coverage"',
    schema: PROSE_SCHEMA,
    seedData: PROSE_DATA,
    dataDescription: "Sprint planning meeting notes as a markdown string.",
    isWrite: true,
    assertResult: (rows) => {
      assertEquals(rows.length, 1, "Write query must return exactly 1 row");
      const row = rows[0] as Record<string, unknown>;
      const data = String(Object.values(row)[0]);
      assertEquals(data.includes("Retrospective"), true, "Should contain new title");
    },
    scoreResult: ({ rows, error }) => {
      if (error !== null) {
        return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
      }
      const row = rows[0] as Record<string, unknown> | undefined;
      const data = row ? String(Object.values(row)[0]) : "";
      const hasRetro = data.includes("Retrospective");
      const hasDate = data.includes("2026-02-27");
      return [
        createScore("sql-valid", 1, "executed successfully"),
        createScore(
          "result-correct",
          hasRetro && hasDate ? 1 : hasRetro ? 0.5 : 0,
          `hasRetro=${hasRetro}, hasDate=${hasDate}`,
        ),
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface ResourceToolResult {
  text: string;
  sql: string;
  params: (string | number | boolean | null)[];
  rows: unknown[];
  error: string | null;
}

export const evals: EvalRegistration[] = cases.map((c) =>
  defineEval<ResourceToolResult>({
    name: `resource-tools-pg/${c.id}`,
    adapter,
    config: {
      input: c.task,
      run: async () => {
        const { text, sql, params } = await generateSQL(c.task, c.schema, c.dataDescription);
        const { rows, error } = await executeDraftQuery(sql, params, c.seedData, c.schema);
        return { text, sql, params, rows, error };
      },
      assert: (result) => {
        if (result.error !== null) {
          throw new Error(`SQL execution failed: ${result.error}\nGenerated SQL:\n${result.sql}`);
        }
        c.assertResult(result.rows);
      },
      score: (result) => c.scoreResult({ rows: result.rows, error: result.error, sql: result.sql }),
      metadata: { case: c.id, isWrite: c.isWrite, schema: c.schema, seedData: c.seedData },
    },
  }),
);
