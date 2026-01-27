# Example: Tasks from CSV-SQLite Design

These examples show the right granularity and context level for sub-agent
execution.

---

## Task 1

**Subject**: Tracer Bullet: Convert CSV file to SQLite with streaming

**Description**:

### Context

Data analyst agent crashes with OOM on large CSVs (~362MB, 1.84M rows). Current
flow loads entire CSV into memory multiple times. We're solving this by
converting CSV to SQLite at upload time and storing `.db` files, so agents can
query without parsing.

### Outcome

A function exists that stream-converts a CSV file to SQLite without loading the
full file into memory.

### Why This Task

This is the tracer bullet - the core primitive everything else builds on. Proves
the streaming approach works before we integrate it into uploads and the agent.

### Acceptance Criteria

- [ ] `convertCsvToSqlite(csvPath, dbPath, tableName)` exists and is exported
- [ ] Returns `{ dbPath, schema }` where schema has `tableName`, `rowCount`,
      `columns`
- [ ] Memory usage stays constant regardless of input file size
- [ ] Resulting `.db` is queryable with `SELECT * FROM tableName`

### Interface Contracts

```typescript
interface ConversionResult {
  dbPath: string;
  schema: {
    tableName: string;
    rowCount: number;
    columns: Array<{ name: string; type: "TEXT" | "INTEGER" | "REAL" }>;
  };
}
```

### Starting Points

- New file: `packages/core/src/artifacts/converters/csv-to-sqlite.ts`
- Papa.parse supports streaming via Node readable streams
- `@db/sqlite` for SQLite bindings (add to package.json)

### Design Reference

docs/plans/2026-01-21-csv-sqlite-storage-design.v2.md § Streaming CSV to SQLite
Converter

---

## Task 2

**Subject**: Add DatabaseArtifact schema to core

**Description**:

### Context

Data analyst agent crashes with OOM on large CSVs. We're solving this by
converting CSV to SQLite at upload time and storing `.db` files as a new
"database" artifact type, so agents can query without parsing.

### Outcome

The artifact system has a new `database` type alongside `file`.

### Why This Task

The converter (Task 1) produces SQLite files. This task creates the artifact
type to store them. Upload handler and agent changes depend on this schema
existing.

### Acceptance Criteria

- [ ] `DatabaseSchemaSchema` and `DatabaseDataSchema` exported from primitives
- [ ] `DatabaseArtifactSchema` added to `ArtifactDataSchema` discriminated union
- [ ] Can create an artifact with `type: "database"` via existing storage API

### Interface Contracts

```typescript
// The schema to add
const DatabaseDataSchema = z.object({
  path: z.string(), // Local path or "cortex://{id}"
  sourceFileName: z.string(), // Original CSV name for display
  schema: DatabaseSchemaSchema, // Table metadata
});

const DatabaseArtifactSchema = z.object({
  type: z.literal("database"),
  version: z.literal(1),
  data: DatabaseDataSchema,
});
```

### Starting Points

- `packages/core/src/artifacts/primitives.ts` for schemas
- `packages/core/src/artifacts/model.ts` for the union
- Follow existing `FileArtifactSchema` pattern

### Design Reference

docs/plans/2026-01-21-csv-sqlite-storage-design.v2.md § New Artifact Type

---

## Task 3

**Subject**: Upload handler detects CSV and calls converter

**Description**:

### Context

Data analyst agent crashes with OOM on large CSVs. We're solving this by
converting CSV to SQLite at upload time. The converter and schema exist; this
task wires them into the upload flow.

### Outcome

POSTing a CSV to `/artifacts/upload` creates a database artifact instead of a
file artifact.

### Why This Task

Connects the converter (Task 1) and schema (Task 2) to the upload flow. After
this, new CSV uploads automatically become queryable databases. Agent changes
come next.

### Acceptance Criteria

- [ ] Upload `test.csv` via POST `/artifacts/upload`, get artifact with
      `type: "database"`
- [ ] `.db` file exists at expected storage path
- [ ] Original CSV not stored (only temp file during conversion)
- [ ] Temp CSV cleaned up after conversion (success or failure)

### Interface Contracts

Detection logic:

```typescript
const isCsv =
  mimeType === "text/csv" ||
  (mimeType === "text/plain" && file.name.toLowerCase().endsWith(".csv"));
```

### Starting Points

- `apps/atlasd/routes/artifacts.ts` - upload handler
- `convertCsvToSqlite` from `@atlas/core/artifacts/converters/csv-to-sqlite`

### Design Reference

docs/plans/2026-01-21-csv-sqlite-storage-design.v2.md § Upload Handler Changes
