# Data Analyst Agent - Design

**Date:** 2026-01-27 **Status:** Implementation Complete **Branch:**
`query-analysis-agent`

---

## Overview

General-purpose agent that analyzes tabular data to answer questions and produce
actionable insights with supporting data.

**Job to be done:** "I have data, I have questions, give me answers I can use."

**Inspiration:**
[Vercel's d0 agent](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools) -
they removed 80% of their tools and gave Claude SQL access + schema context. It
got simpler and better.

---

## Architecture

### Data Flow

```
┌──────────────────┐    ┌─────────────────┐    ┌───────────────────┐
│ User uploads CSV │───>│ Upload handler  │───>│ Stream convert    │
│                  │    │ detects CSV     │    │ to SQLite (.db)   │
└──────────────────┘    └─────────────────┘    └───────────────────┘
                                                        │
                                                        ▼
┌──────────────────┐    ┌─────────────────┐    ┌───────────────────┐
│ Data Analyst     │<───│ ATTACH DATABASE │<───│ "database"        │
│ Agent            │    │ (zero-copy)     │    │ artifact stored   │
└──────────────────┘    └─────────────────┘    └───────────────────┘
        │
        │ LLM loop with SQL tools
        ▼
┌──────────────────┐    ┌─────────────────┐
│ execute_sql      │───>│ Summary +       │
│ save_results     │    │ Data artifacts  │
└──────────────────┘    └─────────────────┘
```

### Input/Output

**Input:** Natural language prompt with artifact IDs (UUIDs extracted via regex)
and the analysis question.

**Output:**

```typescript
type DataAnalystResult = {
  summary: string; // Human-readable findings
  artifactRefs: ArtifactRef[]; // Summary artifact + optional data artifact
};
```

Why separate artifacts? Analysis without explanation is less useful. Summary
provides context ("Q4 revenue was up 23% driven by campaign X"), data artifact
provides receipts. Not every question needs data output - "How many customers
are in California?" is fully answered by summary.

---

## Key Design Decisions

### CSV → SQLite at Upload Time

**Problem:** OOM crashes with large CSVs (~362MB, 1.84M rows). The original flow
loaded CSV into memory multiple times:

```
readFile() → 362MB → ~700MB UTF-16 string → Papa.parse() → ~2GB objects → OOM
```

**Solution:** Convert CSV to SQLite at upload time. Stream conversion with
constant memory. User sees/downloads CSV (transparent abstraction). Agent skips
parsing entirely.

| Decision                   | Rationale                                      |
| -------------------------- | ---------------------------------------------- |
| Convert at upload          | Simpler than on-demand, predictable            |
| One table per artifact     | No multi-table support initially               |
| Delete original CSV        | No fallback needed, saves disk                 |
| Stream conversion          | Never load full CSV into memory                |
| 1000 row cap for UI        | Full download available, preview stays fast    |
| ATTACH DATABASE in agent   | Zero-copy query, no memory duplication         |
| TEXT columns only          | SQLite is type-flexible, Papa handles at read  |

### SQL-First Agent Design

| Decision                   | Rationale                                      |
| -------------------------- | ---------------------------------------------- |
| Full SELECT autonomy       | LLM decides what queries to run                |
| `execute_sql` + `save_results` | Explore data, then explicitly mark final output |
| 30s query timeout          | Prevent pathological queries from hanging      |
| SELECT-only validation     | Reject mutations before execution              |
| In-memory isolation        | Database destroyed when agent completes        |
| stepCountIs(15) loop limit | Prevent infinite tool loops                    |

### Why `save_results` tool?

LLM might run exploratory queries via `execute_sql`, then call `save_results`
with the final query that answers the user's question. Makes output selection
explicit rather than guessing which query result to save.

---

## Implementation Components

### New Artifact Type

```typescript
const DatabaseDataSchema = z.object({
  path: z.string(), // SQLite file path or cortex://{id}
  sourceFileName: z.string(), // Original filename for display/download
  schema: z.object({
    tableName: z.string(),
    rowCount: z.number(),
    columns: z.array(
      z.object({
        name: z.string(),
        type: z.enum(["TEXT", "INTEGER", "REAL"]),
        inferred: z.enum(["text", "numeric", "date", "boolean"]).optional(),
      })
    ),
  }),
});
```

### Streaming CSV Converter

`packages/core/src/artifacts/converters/csv-to-sqlite.ts`

- Papa.parse with Node.js readable stream
- BATCH_SIZE = 5000 rows per transaction
- Memory stays constant regardless of file size
- Cleanup partial .db on error

### Agent Loading

```typescript
// ATTACH instead of copying into memory
db.exec(`ATTACH DATABASE '${dbPath}' AS "${alias}"`);
tables.set(`${alias}.${schema.tableName}`, schema);

// Legacy CSV artifacts still work via in-memory parsing
if (artifact.data.type === "file" && mimeType.includes("csv")) {
  // Parse and load into memory (backwards compat)
}
```

### SQL Tools

**execute_sql:** Run exploratory SELECT queries. Results shown to LLM, not
saved.

**save_results:** Save final query results as artifact. Call once with the
answer.

Both validate SELECT-only before execution. 30s timeout per call.

### Export Endpoint

`GET /artifacts/:id/export?format=csv`

Stream export via SQLite iterator. Never loads all rows into memory.

---

## Files Changed

### Core Infrastructure

| File                                              | Change                                 |
| ------------------------------------------------- | -------------------------------------- |
| `packages/core/src/artifacts/primitives.ts`       | DatabaseSchema, DatabaseData schemas   |
| `packages/core/src/artifacts/model.ts`            | Add database to ArtifactData union     |
| `packages/core/src/artifacts/converters/csv-to-sqlite.ts` | Stream converter (NEW)         |
| `packages/core/src/artifacts/local-adapter.ts`    | readDatabasePreview                    |
| `packages/core/src/artifacts/cortex-adapter.ts`   | Handle database type, preview          |

### Backend

| File                                              | Change                                 |
| ------------------------------------------------- | -------------------------------------- |
| `apps/atlasd/routes/artifacts.ts`                 | CSV detection, conversion, export      |
| `packages/bundled-agents/src/data-analyst/agent.ts` | ATTACH DATABASE, SQL loop            |
| `packages/bundled-agents/src/data-analyst/sql-tools.ts` | execute_sql, save_results tools  |
| `packages/bundled-agents/src/data-analyst/prompts.ts` | System prompt with SQL guidance    |

### Frontend

| File                                              | Change                                 |
| ------------------------------------------------- | -------------------------------------- |
| `apps/web-client/.../library/[artifactId]/+page.svelte` | Database preview, export button  |

---

## Error Handling

| Scenario               | Behavior                              |
| ---------------------- | ------------------------------------- |
| Artifact not found     | Fail agent with clear error           |
| Artifact not CSV/DB    | Fail agent with type mismatch error   |
| CSV parse failure      | Fail agent with details               |
| No artifact IDs        | Fail agent: "Please specify which data" |
| Non-SELECT query       | Return error to LLM, can retry        |
| SQL syntax error       | Return error to LLM, can retry        |
| Query timeout (30s)    | Return timeout error to LLM           |
| Empty artifacts        | Fail agent: "No data rows"            |

---

## Security

**Threat Model:** LLM generates SQL executed against in-memory SQLite.

**Mitigations:**

1. SELECT-only validation before execution
2. In-memory isolation - destroyed on agent completion
3. No external access - SQLite has no network capabilities
4. Error containment - SQL errors returned to LLM, don't crash

**Risk:** LOW. Malformed queries cannot access other sessions' data, corrupt
storage, or exfiltrate information.

---

## Backward Compatibility

- Old `file` artifacts with CSV mime type work via legacy parsing path
- New uploads create `database` artifacts
- No migration required - both types coexist
- UI shows CSV preview/download regardless of storage format

---

## Comparison to CSV Filter Agent

| Aspect        | CSV Filter Agent           | Data Analyst Agent             |
| ------------- | -------------------------- | ------------------------------ |
| Purpose       | Filter + sample rows       | Answer any question            |
| SQL           | Generated WHERE only       | Full SELECT autonomy           |
| Output        | Single file artifact       | Summary + optional data        |
| Flexibility   | Narrow (filter/sample)     | General purpose                |

---

## Future Enhancements (Deferred)

- **Structured input** (TEM-3487): Pass artifact IDs as structured data
- **Multiple formats**: JSON arrays, not just CSV
- **Visualization hints**: Chart specs for frontend rendering
- **Caching**: Cache loaded data for follow-up questions
- **Model configurability**: Allow model override via agent config

---

## Related

- [TEM-3487](https://linear.app/tempestteam/issue/TEM-3487): Structured input for
  SDK agents
- `packages/bundled-agents/src/csv/filter.ts`: Existing CSV filter agent
- [Vercel d0 blog post](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools):
  Inspiration for SQL-first approach
