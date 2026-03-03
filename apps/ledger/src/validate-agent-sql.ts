import { stringifyError } from "@atlas/utils";
import { walk } from "@pgsql/traverse";
import type {
  CommonTableExpr,
  FuncCall,
  Node,
  ParseResult,
  RangeVar,
  SelectStmt,
  SQLValueFunction,
  SQLValueFunctionOp,
  TypeCast,
} from "@pgsql/types";
import { parse } from "pgsql-parser";

// ---------------------------------------------------------------------------
// Function allowlist (~80 functions, organized by category)
// ---------------------------------------------------------------------------

const JSONB_FUNCTIONS = [
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_array_length",
  "jsonb_build_object",
  "jsonb_build_array",
  "jsonb_set",
  "jsonb_set_lax",
  "jsonb_insert",
  "jsonb_agg",
  "jsonb_object_agg",
  "jsonb_strip_nulls",
  "jsonb_typeof",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_object_keys",
  "jsonb_pretty",
  "jsonb_path_query",
  "jsonb_path_query_first",
  "jsonb_path_query_array",
  "jsonb_path_exists",
  "jsonb_path_match",
  "to_jsonb",
] as const;

const AGGREGATE_FUNCTIONS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "array_agg",
  "string_agg",
  "bool_and",
  "bool_or",
] as const;

const WINDOW_FUNCTIONS = [
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "ntile",
  "first_value",
  "last_value",
] as const;

const STRING_FUNCTIONS = [
  "lower",
  "upper",
  "length",
  "char_length",
  "btrim",
  "ltrim",
  "rtrim",
  "substring",
  "replace",
  "regexp_replace",
  "regexp_match",
  "starts_with",
  "concat",
  "concat_ws",
  "format",
  "split_part",
  "left",
  "right",
  "strpos",
  "reverse",
  "position",
] as const;

const MATH_FUNCTIONS = [
  "abs",
  "round",
  "ceil",
  "ceiling",
  "floor",
  "trunc",
  "mod",
  "power",
  "sqrt",
  "random",
] as const;

const DATE_FUNCTIONS = [
  "now",
  "clock_timestamp",
  "date_trunc",
  "date_part",
  "extract",
  "age",
  "to_char",
  "to_number",
  "to_date",
  "to_timestamp",
  "make_date",
  "make_interval",
] as const;

const ARRAY_FUNCTIONS = ["array_length", "unnest", "array_to_string", "cardinality"] as const;

const FUNCTION_CATEGORIES = [
  { label: "JSONB", functions: JSONB_FUNCTIONS },
  { label: "Aggregate", functions: AGGREGATE_FUNCTIONS },
  { label: "Window", functions: WINDOW_FUNCTIONS },
  { label: "String", functions: STRING_FUNCTIONS },
  { label: "Math", functions: MATH_FUNCTIONS },
  { label: "Date/time", functions: DATE_FUNCTIONS },
  { label: "Array", functions: ARRAY_FUNCTIONS },
] as const;

const ALLOWED_FUNCTIONS = new Set<string>(
  FUNCTION_CATEGORIES.flatMap((category) => [...category.functions]),
);

// ---------------------------------------------------------------------------
// Blocked SQLValueFunction ops (role identity leakage)
// ---------------------------------------------------------------------------

const BLOCKED_SVFOPS = new Set<SQLValueFunctionOp>([
  "SVFOP_CURRENT_USER",
  "SVFOP_SESSION_USER",
  "SVFOP_CURRENT_ROLE",
  "SVFOP_USER",
  "SVFOP_CURRENT_CATALOG",
  "SVFOP_CURRENT_SCHEMA",
]);

// ---------------------------------------------------------------------------
// Blocked pseudo-type casts (implicit catalog queries)
// ---------------------------------------------------------------------------

const BLOCKED_REG_TYPES = new Set([
  "regclass",
  "regtype",
  "regproc",
  "regprocedure",
  "regoper",
  "regoperator",
  "regnamespace",
  "regconfig",
  "regdictionary",
  "regrole",
  "regcollation",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFunctionHint(): string {
  return FUNCTION_CATEGORIES.map((category) => {
    return `  ${category.label}: ${category.functions.join(", ")}`;
  }).join("\n");
}

function extractStringValue(node: Node): string | undefined {
  if ("String" in node) {
    return node.String.sval;
  }
  return undefined;
}

function collectCteNamesAndValidate(root: Node): Set<string> {
  const cteNames = new Set<string>();

  walk(root, {
    // walk() types path.node as `any` — visitor key guarantees the node type
    CommonTableExpr: (path) => {
      const cte = path.node as CommonTableExpr;
      if (cte.ctename) {
        cteNames.add(cte.ctename);
      }

      const cteQuery = cte.ctequery;
      if (cteQuery === null || cteQuery === undefined) {
        return;
      }

      if (!("SelectStmt" in cteQuery)) {
        const stmtType = Object.keys(cteQuery)[0] ?? "unknown";
        throw new Error(
          `Only SELECT is allowed in CTEs (got ${stmtType}); data-modifying CTEs are not permitted`,
        );
      }
    },
  });

  return cteNames;
}

function validateFuncCall(node: FuncCall): void {
  const funcname = node.funcname;
  if (!funcname || funcname.length === 0) {
    return;
  }

  const first = funcname[0];
  if (funcname.length === 1) {
    if (!first) return;
    const functionName = extractStringValue(first);
    if (!functionName) {
      return;
    }

    if (!ALLOWED_FUNCTIONS.has(functionName)) {
      throw new Error(
        `Function '${functionName}' is not allowed.\nAllowed functions:\n${formatFunctionHint()}`,
      );
    }
    return;
  }

  const second = funcname[1];
  if (!first || !second) return;
  const schemaName = extractStringValue(first);
  const functionName = extractStringValue(second);
  if (!schemaName || !functionName) {
    return;
  }

  if (schemaName !== "pg_catalog") {
    throw new Error(
      `Schema-qualified function '${schemaName}.${functionName}' is not allowed. Only pg_catalog functions are permitted.`,
    );
  }

  if (!ALLOWED_FUNCTIONS.has(functionName)) {
    throw new Error(
      `Function '${functionName}' is not allowed.\nAllowed functions:\n${formatFunctionHint()}`,
    );
  }
}

function validateSqlValueFunction(node: SQLValueFunction): void {
  const op = node.op;
  if (!op) {
    return;
  }

  if (BLOCKED_SVFOPS.has(op)) {
    const name = op.replace("SVFOP_", "").toLowerCase();
    throw new Error(`'${name}' is not allowed in agent SQL`);
  }
}

function validateRangeVar(node: RangeVar, allowedTables: Set<string>): void {
  const relname = node.relname;
  if (!relname) {
    throw new Error("Table reference has unexpected shape");
  }

  const schemaname = node.schemaname;
  if (schemaname && schemaname.length > 0) {
    throw new Error(
      `Schema-qualified table '${schemaname}.${relname}' is not allowed. Only the 'draft' table is accessible.`,
    );
  }

  if (!allowedTables.has(relname)) {
    throw new Error(`Table '${relname}' is not allowed. Only the 'draft' table is accessible.`);
  }
}

function validateTypeCast(node: TypeCast): void {
  const names = node.typeName?.names;
  if (!names) {
    return;
  }

  for (const nameNode of names) {
    const typeNamePart = extractStringValue(nameNode);
    if (typeNamePart && BLOCKED_REG_TYPES.has(typeNamePart)) {
      throw new Error(
        `Type cast to '${typeNamePart}' is not allowed. Pseudo-type casts can leak system catalog information.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates agent SQL against the AST-based security policy.
 * Throws with a descriptive error message if the SQL is invalid.
 * The error message includes categorized hints for rejected functions.
 *
 * Validation stages:
 * 1. Parse — reject unparseable SQL
 * 2. Single statement — reject multi-statement SQL
 * 3. Statement type allowlist — only SELECT allowed
 * 4. Recursive CTE block — WITH RECURSIVE rejected
 * 5. AST walk — validate functions, tables, types, value functions
 * 6. Schema gate — only pg_catalog schema prefix allowed on functions
 */
export async function validateAgentSql(sql: string): Promise<void> {
  let parseResult: ParseResult;
  try {
    parseResult = (await parse(sql)) as ParseResult;
  } catch (error: unknown) {
    const message = stringifyError(error);
    throw new Error(`SQL parse error: ${message}`);
  }

  const stmts = parseResult.stmts;
  if (!stmts) {
    throw new Error("SQL parse error: parser returned unexpected AST shape");
  }

  // Stage 2: Single statement
  if (stmts.length !== 1) {
    throw new Error(`Only single SQL statements are allowed (got ${stmts.length})`);
  }

  const rawStmt = stmts[0];
  if (!rawStmt) {
    throw new Error("SQL parse error: empty statement list");
  }

  const stmt = rawStmt.stmt;
  if (!stmt) {
    throw new Error("SQL parse error: empty statement node");
  }

  // Stage 3: Statement type allowlist — only SelectStmt
  if (!("SelectStmt" in stmt)) {
    const statementType = Object.keys(stmt)[0] ?? "unknown";
    throw new Error(`Only SELECT statements are allowed (got ${statementType})`);
  }

  const selectStmt: SelectStmt = stmt.SelectStmt;

  // Stage 3b: Block SELECT INTO (creates a new table — DDL smuggled as SelectStmt)
  if (selectStmt.intoClause !== undefined && selectStmt.intoClause !== null) {
    throw new Error("SELECT INTO is not allowed. Only pure SELECT queries are permitted.");
  }

  // Stage 3c: Block locking clauses (FOR UPDATE/SHARE — side effects in SELECT)
  if (selectStmt.lockingClause !== undefined && selectStmt.lockingClause !== null) {
    throw new Error("FOR UPDATE/SHARE is not allowed. Only pure SELECT queries are permitted.");
  }

  // Stage 4: Recursive CTE block
  if (selectStmt.withClause?.recursive === true) {
    throw new Error("Recursive CTEs (WITH RECURSIVE) are not allowed");
  }

  const allowedTables = new Set(["draft"]);
  const cteNames = collectCteNamesAndValidate(stmt);
  for (const cteName of cteNames) {
    allowedTables.add(cteName);
  }

  // Stages 5 & 6: AST walk (functions, tables, types, schema gate)
  // walk() types path.node as `any` — visitor key guarantees the node type
  walk(stmt, {
    FuncCall: (path) => validateFuncCall(path.node as FuncCall),
    SQLValueFunction: (path) => validateSqlValueFunction(path.node as SQLValueFunction),
    RangeVar: (path) => validateRangeVar(path.node as RangeVar, allowedTables),
    TypeCast: (path) => validateTypeCast(path.node as TypeCast),
  });
}
