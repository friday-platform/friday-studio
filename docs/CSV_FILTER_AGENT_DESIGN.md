# CSV Filter Sampler Agent - Implementation Documentation

## Overview
The CSV Filter Sampler agent reads CSV files, filters data using natural language criteria, and returns N random samples as a structured JSON artifact for downstream agent consumption.

## Agent ID
`csv-filter-sampler`

## Implementation Approach
**SQLite-based filtering with LLM-generated SQL WHERE clauses**

Why SQLite over CSV operations:
- Single query handles filtering + random sampling efficiently
- Natural integration with LLM-generated SQL
- Window functions for filtered count without extra queries
- In-memory operation (fast, no persistence needed)
- ~220 lines of focused code

## Input/Output

### Input (Natural Language String)
```typescript
// Examples:
"Read /data/contacts.csv and filter for United States contacts with decision-making titles, sample 3"
"Filter leads.csv for qualified prospects in enterprise segment, select 5 random samples"
```

### Output
```typescript
{
  summary: string;           // e.g., "Filtered 1000 total records to 87 matching records, sampled 3"
  artifactRef: ArtifactRef;
}

type ArtifactRef = {
  id: string;      // File path relative to workspace files directory
  type: "file";
  summary: string; // e.g., "CSV filter results: 3 sample(s) from 87 filtered record(s)"
}
```

### Artifact JSON Structure
File artifact contains:
```json
{
  "metadata": {
    "totalRecords": 1000,
    "filteredCount": 87,
    "sampleCount": 3,
    "unprocessedCount": 84,
    "csvPath": "/data/contacts.csv",
    "filterCriteria": "United States contacts with decision-making titles",
    "sqlWhereClause": "\"Country\" = 'USA' AND (\"title\" LIKE '%CEO%' OR \"Seniority\" = 'C suite')",
    "timestamp": "2025-11-06T10:30:00.000Z"
  },
  "samples": [
    { "name": "Alice Smith", "title": "CEO", "Country": "USA" },
    { "name": "Bob Jones", "title": "CFO", "Country": "USA" },
    { "name": "Carol Lee", "title": "CTO", "Country": "USA" }
  ]
}
```

## Architecture Flow

### 1. Parse Prompt (LLM: Claude Haiku 4.5)
```typescript
const { csvPath, filterCriteria, sampleCount } = await generateObject({
  model: anthropic("claude-haiku-4-5"),
  schema: PromptParseSchema,
  prompt
});
// Default sampleCount: 3
```

### 2. Load CSV into SQLite
```typescript
// Parse CSV
const parsedCsv = await parseCsv(csvPath);

// Create in-memory database
const db = new Database(":memory:");
db.exec(`CREATE TABLE data (${columnDefs})`);

// Bulk insert with transaction
db.exec("BEGIN TRANSACTION");
for (const row of parsedCsv.data) {
  insertStmt.run(...values);
}
db.exec("COMMIT");
```

### 3. Generate SQL WHERE Clause (LLM: Claude Sonnet 4.5)
```typescript
let whereClause = "";

const buildSqlWhereTool = tool({
  description: "Build SQL WHERE clause",
  inputSchema: z.object({ whereClause: z.string() }),
  execute: (params) => {
    // Validate by executing COUNT query
    const testQuery = params.whereClause
      ? `SELECT COUNT(*) FROM data WHERE ${params.whereClause}`
      : `SELECT COUNT(*) FROM data`;
    db.prepare(testQuery).get(); // Throws on invalid SQL

    whereClause = params.whereClause;
    return { success: true };
  }
});

await generateText({
  model: anthropic("claude-sonnet-4-5"),
  system: `Generate SQL WHERE clause. Available columns: ${columns}

  SQL RULES:
  - Quote column names with spaces: "column name"
  - String literals use single quotes: 'value'
  - LIKE for pattern matching: "title" LIKE '%CEO%'
  - IN for multiple values: "Seniority" IN ('C suite', 'VP')
  - Use 1=0 for impossible filters
  - Empty string for no filtering`,
  prompt: filterCriteria,
  tools: { buildSqlWhere: buildSqlWhereTool }
});
```

### 4. Execute Query with Random Sampling
```typescript
// Single query: filter + random sample + get filtered count
const query = whereClause
  ? `SELECT *, COUNT(*) OVER() as total_count
     FROM data
     WHERE ${whereClause}
     ORDER BY RANDOM()
     LIMIT ${sampleCount}`
  : `SELECT *, COUNT(*) OVER() as total_count
     FROM data
     ORDER BY RANDOM()
     LIMIT ${sampleCount}`;

const rawSamples = db.prepare(query).all();
const filteredCount = rawSamples[0]?.total_count ?? 0;
const samples = rawSamples.map(({ total_count, ...sample }) => sample);
```

### 5. Create File Artifact
```typescript
const artifactStorage = new ArtifactStorage(db, session.workspaceId);

const artifact = await artifactStorage.createFileArtifact({
  fileName: `csv-filter-${Date.now()}.json`,
  data: JSON.stringify({
    metadata: {
      totalRecords: parsedCsv.rowCount,
      filteredCount,
      sampleCount: samples.length,
      unprocessedCount: filteredCount - samples.length,
      csvPath,
      filterCriteria,
      sqlWhereClause: whereClause || "(no filter)",
      timestamp: new Date().toISOString()
    },
    samples
  }, null, 2),
  summary: `CSV filter results: ${samples.length} sample(s) from ${filteredCount} filtered record(s)`
});
```

### 6. Return Result
```typescript
return {
  summary: `Filtered ${totalRecords} total records to ${filteredCount} matching records, sampled ${samples.length} random record(s). ${unprocessedCount} record(s) left unprocessed.`,
  artifactRef: {
    id: artifact.filePath,
    type: "file",
    summary: artifact.summary
  }
};
```

## Security Considerations

### SQL Injection Mitigation
**Risk**: LLM generates SQL WHERE clauses directly interpolated into queries

**Mitigations**:
1. **In-memory database**: No persistent data at risk
2. **Isolated process**: No network access, no data exfiltration possible
3. **Validation**: Every WHERE clause tested with COUNT query before use
4. **Read-only operations**: No UPDATE/DELETE/DROP possible (only SELECT)
5. **Workspace isolation**: Each session has separate database instance
6. **No user data exposure**: CSV data never leaves workspace context

**Risk assessment**: Low. Even if LLM generates malicious SQL:
- Cannot access other workspaces (in-memory DB)
- Cannot exfiltrate data (isolated process)
- Cannot corrupt data (read-only SELECT operations)
- Syntax errors caught by validation

### Path Validation
- `Deno.stat()` verifies file exists before parsing
- `parseCsv()` handles file read errors
- Workspace isolation prevents path traversal

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| CSV file not found | Throws error: "CSV file not found: {path}" |
| Empty CSV (headers only) | Returns artifact with samples: [], counts: 0/0/0 |
| No matches after filtering | Returns artifact with samples: [], counts: N/0/0 |
| Fewer matches than sample count | Returns all matches (e.g., 2 samples if only 2 match) |
| Invalid SQL syntax | LLM retries with corrected WHERE clause |
| "Show all" / no filter needed | Empty WHERE clause, samples from all rows |
| Sample count in prompt | Extracted by LLM (e.g., "5 samples" → sampleCount: 5) |

## Dependencies

### Direct Dependencies
- `@atlas/agent-sdk` - Agent framework (`createAgent`, `ArtifactRef`)
- `@atlas/core` - Anthropic provider + `parseCsv()`
- `@atlas/core/artifacts/server` - `ArtifactStorage` for file artifacts
- `@atlas/utils/paths.server` - `getWorkspaceFilesDir()`
- `@db/sqlite` - In-memory SQLite database
- `ai` SDK - `generateObject`, `generateText`, `tool`
- `zod` - Schema validation
- `@std/path` - `basename()`, `join()`

### Why SQLite?
- Faster than iterative filtering (single query vs multiple passes)
- Natural fit for LLM-generated SQL
- Window functions (COUNT(*) OVER()) avoid extra queries
- ORDER BY RANDOM() built-in
- Standard SQL syntax LLMs understand well

## Example Usage

```typescript
// Prompt:
"Filter /data/employees.csv for engineers making over 100k, give me 3 random samples"

// Agent execution:
// 1. Parses CSV → 1500 rows
// 2. Generates SQL: WHERE "department" = 'Engineering' AND CAST("salary" AS INTEGER) > 100000
// 3. Executes: SELECT *, COUNT(*) OVER() ... WHERE ... ORDER BY RANDOM() LIMIT 3
// 4. Returns: 47 matches, 3 samples

// Response:
{
  summary: "Filtered 1500 total records to 47 matching records, sampled 3 random record(s). 44 record(s) left unprocessed.",
  artifactRef: {
    id: "csv-filter-1730896200000.json",
    type: "file",
    summary: "CSV filter results: 3 sample(s) from 47 filtered record(s)"
  }
}

// Artifact file (workspace/files/csv-filter-1730896200000.json):
{
  "metadata": {
    "totalRecords": 1500,
    "filteredCount": 47,
    "sampleCount": 3,
    "unprocessedCount": 44,
    "csvPath": "/data/employees.csv",
    "filterCriteria": "engineers making over 100k",
    "sqlWhereClause": "\"department\" = 'Engineering' AND CAST(\"salary\" AS INTEGER) > 100000",
    "timestamp": "2025-11-06T10:30:00.000Z"
  },
  "samples": [
    { "name": "Alice Smith", "department": "Engineering", "salary": "125000", "yearsExperience": "8" },
    { "name": "Bob Jones", "department": "Engineering", "salary": "110000", "yearsExperience": "6" },
    { "name": "Carol Lee", "department": "Engineering", "salary": "105000", "yearsExperience": "5" }
  ]
}
```

## Testing

Comprehensive eval suite in `tools/evals/agents/csv-contact-sampler/`:
- Generates 1000 fake contacts using @faker-js/faker
- Tests filtering accuracy (USA + decision-makers)
- Verifies randomness across multiple runs
- Tests edge case (empty results)
- All 3 tests passing

Run tests:
```bash
deno task test tools/evals/agents/csv-contact-sampler/csv-contact-sampler.eval.ts
```

## Files

### Implementation
- `packages/bundled-agents/src/csv/filter.ts` (222 lines)
- `packages/bundled-agents/src/index.ts` (registration)

### Tests
- `tools/evals/agents/csv-contact-sampler/csv-contact-sampler.eval.ts`
- `tools/evals/agents/csv-contact-sampler/generate-fake-data.ts`

### Documentation
- `docs/CSV_FILTER_AGENT_DESIGN.md` (this file)
