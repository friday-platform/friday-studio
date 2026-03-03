/**
 * Resource Tools — JSONB query generation eval.
 *
 * Tests skill document effectiveness: given the SQLite adapter skill text,
 * a resource schema, and a natural language task, can an LLM generate
 * syntactically correct and semantically valid JSONB queries?
 *
 * Each case:
 * 1. Sends the skill doc + schema + task to an LLM via generateText
 * 2. Extracts SQL from the response
 * 3. Executes it against an in-memory SQLite database with a `draft` CTE
 * 4. Scores: sql-valid (executes without error), result-correct (matches expected)
 *
 * Ground truth values computed independently via SQLite JSON1 functions.
 */

import { registry, traceModel } from "@atlas/llm";
import { Database } from "@db/sqlite";
import { generateText } from "ai";
import { SQLITE_SKILL_TEXT } from "../../../../apps/ledger/src/sqlite-skill.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();
const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Scoring helper
// ---------------------------------------------------------------------------

/**
 * @description Wraps the common sql-valid / result-correct scoring pattern.
 * Returns sql-valid=0 on error; otherwise sql-valid=1 + the caller's result score.
 */
function scoreSQL(error: string | null, checkResult: () => Score): Score[] {
  if (error !== null) {
    return [createScore("sql-valid", 0, error), createScore("result-correct", 0, "SQL failed")];
  }
  return [createScore("sql-valid", 1, "executed successfully"), checkResult()];
}

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

const GROCERY_DESC =
  "A grocery list with 8 items, each having item, quantity, category, and price fields.";

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

const MEETING_DESC = "A meeting record with title, date, attendees, and action items.";

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an agent that works with workspace resources using SQL queries against a JSONB-backed SQLite database.

${SQLITE_SKILL_TEXT}

When asked to perform an operation on a resource, respond with ONLY the SQL query inside a single code block. No explanation, no commentary — just the SQL.

For read operations, use resource_read queries (SELECT that reads data).
For write operations, use resource_write queries (SELECT that returns the new data value).

If the task requires parameters (like prose content), also output the params as a JSON array on a separate line prefixed with "PARAMS: ".`;

/**
 * @description Extracts the first column value from a single-row query result.
 * Handles both string (needs JSON.parse) and already-parsed (auto-deserialized
 * by @db/sqlite) values.
 */
function extractResultValue(row: Record<string, unknown>): unknown {
  const val = Object.values(row)[0];
  if (typeof val === "string") {
    return JSON.parse(val) as unknown;
  }
  return val;
}

/**
 * @description Extracts the first SQL code block from LLM response text.
 * Falls back to treating the entire response as SQL if no code block found.
 */
function extractSQL(response: string): { sql: string; params: string[] } {
  const codeBlockMatch = response.match(/```(?:sql)?\s*\n?([\s\S]*?)```/);
  const sql = codeBlockMatch?.[1]?.trim() ?? response.trim();

  const paramsMatch = response.match(/PARAMS:\s*(\[.*\])/);
  const params: string[] = paramsMatch?.[1] ? (JSON.parse(paramsMatch[1]) as string[]) : [];

  return { sql, params };
}

/**
 * @description Executes SQL against an in-memory SQLite database with
 * a `draft` CTE pre-populated with the given test data and schema.
 *
 * Uses a backing table for seed data and collapses multiline SQL to
 * single-line to work around @db/sqlite FFI issues with multiline
 * statements containing JSON path expressions like `$[#]`.
 */
function executeDraftQuery(
  sql: string,
  params: string[],
  data: string,
  schema: string,
): { rows: unknown[]; error: string | null } {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE _draft_seed (data TEXT NOT NULL, schema TEXT NOT NULL)`);
    db.prepare(`INSERT INTO _draft_seed (data, schema) VALUES (json(:data), json(:schema))`).run({
      ":data": data,
      ":schema": schema,
    });

    // Collapse newlines to spaces — @db/sqlite prepare() has FFI issues with
    // multiline SQL containing `$` in JSON paths (e.g. `$[#]`, `$.field`).
    const fullSQL = `WITH draft AS (SELECT data, schema FROM _draft_seed) ${sql}`.replace(
      /\n/g,
      " ",
    );

    // Map positional $1, $2... params to named :p1, :p2...
    const rewritten = fullSQL.replace(/\$(\d+)/g, (_match, num) => `:p${num}`);
    const bindParams: Record<string, string> = {};
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (param !== undefined) {
        bindParams[`:p${i + 1}`] = param;
      }
    }

    const rows = db.prepare(rewritten).all(bindParams) as unknown[];
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    db.close();
  }
}

/**
 * @description Asks the LLM to generate SQL for a resource task.
 */
async function generateSQL(
  task: string,
  schema: string,
  dataDescription: string,
): Promise<{ text: string; sql: string; params: string[] }> {
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
    dataDescription: GROCERY_DESC,
    isWrite: false,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () =>
        createScore("result-correct", rows.length === 8 ? 1 : 0, `${rows.length}/8 rows`),
      ),
  },
  {
    id: "tabular-read-filter",
    name: "tabular read - filter by quantity",
    task: "Show me all grocery items where the quantity is greater than 2.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription: GROCERY_DESC,
    isWrite: false,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () =>
        createScore("result-correct", rows.length === 3 ? 1 : 0, `${rows.length}/3 rows`),
      ),
  },
  {
    id: "tabular-read-aggregate",
    name: "tabular read - sum prices",
    task: "What is the sum of all price values on the grocery list? Just add up the price field for every item.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription: GROCERY_DESC,
    isWrite: false,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        const total = row ? (Object.values(row)[0] as number) : 0;
        return createScore(
          "result-correct",
          Math.abs(total - 40.42) < 0.01 ? 1 : 0,
          `got ${total}, expected ~40.42`,
        );
      }),
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
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const dairyRow = rows.find((r) => {
          const values = Object.values(r as Record<string, unknown>);
          return values.some((v) => typeof v === "string" && v.toLowerCase() === "dairy");
        }) as Record<string, unknown> | undefined;
        const dairyCount = dairyRow
          ? Object.values(dairyRow).find((v) => typeof v === "number" && v === 3)
          : undefined;
        return createScore(
          "result-correct",
          rows.length === 5 && dairyCount !== undefined ? 1 : rows.length === 5 ? 0.5 : 0,
          `${rows.length} groups, dairy count=${dairyCount ?? "not found"}`,
        );
      }),
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
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        const count = row ? (Object.values(row)[0] as number) : 0;
        return createScore("result-correct", count === 8 ? 1 : 0, `got ${count}, expected 8`);
      }),
  },

  // === Tabular writes ===
  {
    id: "tabular-append",
    name: "tabular write - append row",
    task: 'Add "bananas" (quantity 5, category "produce", price 2.49) to the grocery list.',
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription: GROCERY_DESC,
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        if (rows.length !== 1) {
          return createScore("result-correct", 0, `Expected 1 result row, got ${rows.length}`);
        }
        const row = rows[0] as Record<string, unknown>;
        const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
        const hasBananas = parsed.some(
          (item) => (item.item as string)?.toLowerCase() === "bananas",
        );
        return createScore(
          "result-correct",
          parsed.length === 9 && hasBananas ? 1 : parsed.length === 9 ? 0.5 : 0,
          `${parsed.length} items, bananas=${hasBananas}`,
        );
      }),
  },
  {
    id: "tabular-multi-field-update",
    name: "tabular write - update multiple fields",
    task: "Update eggs: set quantity to 24 and price to 6.99.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription: GROCERY_DESC,
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return createScore("result-correct", 0, "no result row");
        const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
        const eggs = parsed.find((i) => i.item === "eggs");
        const qtyOk = eggs?.quantity === 24;
        const priceOk = eggs?.price === 6.99;
        return createScore(
          "result-correct",
          qtyOk && priceOk ? 1 : qtyOk || priceOk ? 0.5 : 0,
          `eggs.quantity=${eggs?.quantity}, eggs.price=${eggs?.price}`,
        );
      }),
  },
  {
    id: "tabular-remove",
    name: "tabular write - remove rows by filter",
    task: "Remove all items in the dairy category from the grocery list.",
    schema: GROCERY_SCHEMA,
    seedData: GROCERY_DATA,
    dataDescription: `${GROCERY_DESC} 3 items are in the dairy category.`,
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return createScore("result-correct", 0, "no result row");
        const parsed = extractResultValue(row) as Array<Record<string, unknown>>;
        const hasDairy = parsed.some((i) => i.category === "dairy");
        return createScore(
          "result-correct",
          parsed.length === 5 && !hasDairy ? 1 : !hasDairy ? 0.5 : 0,
          `items=${parsed.length}, hasDairy=${hasDairy}`,
        );
      }),
  },

  // === Document (hierarchical) reads ===
  {
    id: "document-nested-read-fields",
    name: "document (hierarchical) read - extract top-level fields",
    task: "What is the meeting title and date?",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: MEETING_DESC,
    isWrite: false,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return createScore("result-correct", 0, "no result row");
        const values = Object.values(row);
        const hasTitle = values.some((v) => v === "Sprint Planning");
        const hasDate = values.some((v) => v === "2026-02-20");
        return createScore(
          "result-correct",
          hasTitle && hasDate ? 1 : hasTitle || hasDate ? 0.5 : 0,
          `title=${hasTitle}, date=${hasDate}`,
        );
      }),
  },
  {
    id: "document-nested-read-iterate",
    name: "document (hierarchical) read - iterate nested array with filter",
    task: "List all action items that are not done yet.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: MEETING_DESC,
    isWrite: false,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () =>
        createScore("result-correct", rows.length === 2 ? 1 : 0, `${rows.length}/2 undone items`),
      ),
  },

  // === Document (hierarchical) writes ===
  {
    id: "document-nested-write-update",
    name: "document (hierarchical) write - update element in nested array",
    task: "Mark Alice's 'finalize schema' action item as done.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: MEETING_DESC,
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return createScore("result-correct", 0, "no result row");
        const newData = extractResultValue(row) as Record<string, unknown>;
        const items = newData.action_items as Array<Record<string, unknown>> | undefined;
        if (!items) return createScore("result-correct", 0, "no action_items in result");
        const target = items.find((i) => i.task === "finalize schema" && i.assignee === "Alice");
        const others = items.filter(
          (i) => !(i.task === "finalize schema" && i.assignee === "Alice"),
        );
        return createScore(
          "result-correct",
          target?.done === true && others.length === 3 ? 1 : target?.done === true ? 0.5 : 0,
          `target.done=${target?.done}, othersCount=${others.length}`,
        );
      }),
  },
  {
    id: "document-nested-write-append",
    name: "document (hierarchical) write - append to nested array",
    task: "Add a new action item: task 'Write docs', assignee 'Charlie', done false.",
    schema: MEETING_SCHEMA,
    seedData: MEETING_DATA,
    dataDescription: "A meeting record with title, date, attendees, and 4 action items.",
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return createScore("result-correct", 0, "no result row");
        const newData = extractResultValue(row) as Record<string, unknown>;
        const items = newData.action_items as Array<Record<string, unknown>> | undefined;
        if (!items) return createScore("result-correct", 0, "no action_items in result");
        const added = items.find((i) => i.task === "Write docs");
        const countOk = items.length === 5;
        const contentOk = added?.assignee === "Charlie" && added?.done === false;
        return createScore(
          "result-correct",
          countOk && contentOk ? 1 : countOk || contentOk ? 0.5 : 0,
          `items=${items.length}, added=${JSON.stringify(added)}`,
        );
      }),
  },

  // === Prose ===
  {
    id: "prose-write",
    name: "prose write - replace content",
    task: 'Replace the meeting notes with: "# Retrospective\\n\\nDate: 2026-02-27\\n\\n## What went well\\n- Shipped on time\\n\\n## What to improve\\n- Better test coverage"',
    schema: PROSE_SCHEMA,
    seedData: PROSE_DATA,
    dataDescription: "Sprint planning meeting notes as a markdown string.",
    isWrite: true,
    scoreResult: ({ rows, error }) =>
      scoreSQL(error, () => {
        const row = rows[0] as Record<string, unknown> | undefined;
        const data = row ? (Object.values(row)[0] as string) : "";
        const hasRetro = typeof data === "string" && data.includes("Retrospective");
        const hasDate = typeof data === "string" && data.includes("2026-02-27");
        return createScore(
          "result-correct",
          hasRetro && hasDate ? 1 : hasRetro ? 0.5 : 0,
          `hasRetro=${hasRetro}, hasDate=${hasDate}`,
        );
      }),
  },
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** @description Result type flowing through the eval lifecycle. */
interface ResourceToolResult {
  text: string;
  sql: string;
  params: string[];
  rows: unknown[];
  error: string | null;
}

export const evals: EvalRegistration[] = cases.map((c) =>
  defineEval<ResourceToolResult>({
    name: `resource-tools/${c.id}`,
    adapter,
    config: {
      input: c.task,
      run: async () => {
        const { text, sql, params } = await generateSQL(c.task, c.schema, c.dataDescription);
        const { rows, error } = executeDraftQuery(sql, params, c.seedData, c.schema);
        return { text, sql, params, rows, error };
      },
      score: (result) => c.scoreResult({ rows: result.rows, error: result.error, sql: result.sql }),
      metadata: { case: c.id, isWrite: c.isWrite, schema: c.schema, seedData: c.seedData },
    },
  }),
);
