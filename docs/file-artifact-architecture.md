# File Artifact Architecture

## Problem Statement

Deno KV has a 64KB per-value limit. Current artifact system stores all data
inline in KV, which fails for large CSV files (even 1MB CSVs with ~10K rows).
The CSV tool currently accepts raw file paths and embeds entire datasets in
table artifacts, hitting this limit consistently.

## Goals

1. Support large files (CSV, JSON, etc.) without KV size limits
2. Maintain type safety throughout the system
3. Use extension-based parsing for different file types
4. CSV tool should work with artifacts, not raw file paths
5. Replace table artifacts with file artifacts (breaking change)

## Architecture Design

### 1. Artifact Type Strategy

**Decision: Create `file` artifact type with extension-based typing**

```typescript
// New artifact type
{
  type: "file",
  version: 1,
  data: {
    path: string,     // Absolute path to stored file
    mimeType: string, // MIME type for parser selection (e.g., text/csv, application/json)
  }
}
```

**Why not typed file artifacts (csv-file, json-file)?**

- MIME type provides standardized type information
- Parser registry maps MIME type → parser
- Simpler schema (one file type vs. many)
- More flexible (new MIME types don't require schema changes)

**Removing table artifact type:**

- `table` artifact is being replaced by `file` artifacts
- Breaking change - existing table artifacts will no longer work
- All structured data (CSV, JSON, etc.) uses file storage
- Other types unchanged: `summary`, `workspace-plan`, `calendar-schedule`,
  `slack-summary`

### 2. Storage Architecture

**File Storage Location:**

File artifacts are **references only** - no copying or moving files.

- User files: remain at their original location (e.g., `/tmp/sales.csv`, `/home/user/data.csv`)
- Generated files: stored in `~/.atlas/artifacts/{workspaceId}/` for persistence

```
~/.atlas/artifacts/{workspaceId}/
  ├── {uuid}.csv    # Generated/transformed files
  └── {uuid}.json
```

**File artifacts do NOT copy files** - they only store the path reference.

**KV Storage (metadata only):**

```typescript
// KV stores only file reference
["artifact", artifactId, revision] = {
  id: string,
  type: "file",
  revision: number,
  data: {
    path: "/home/.atlas/artifacts/abc-123/uuid-v4.csv",
    mimeType: "text/csv",
  },
  summary: string,
  // ... other artifact fields
};
```

**Atomic Operations:**

- Create: Validate file exists, then KV transaction (no copying)
- Update: Update metadata only (file reference can change)
- Delete: Soft delete in KV only (files remain on disk)
- No rollback needed: files are never copied or moved

### 3. Parser Registry System

**Parser Interface:**

```typescript
interface FileParser<T = unknown> {
  mimeType: string;
  parse(filePath: string): Promise<ParsedFileResult<T>>;
}

interface ParsedFileResult<T> {
  data: T;
  metadata?: Record<string, unknown>;
}
```

**CSV Parser:**

```typescript
interface CsvParseResult {
  data: Array<Record<string, CsvCell>>;
  columns: string[];
  rowCount: number;
}

const csvParser: FileParser<CsvParseResult> = {
  mimeType: "text/csv",
  async parse(filePath: string): Promise<ParsedFileResult<CsvParseResult>> {
    // Use existing Papa.parse logic from utils.ts
    const rawContent = await Deno.readTextFile(filePath);
    const content = findHeaderLine(rawContent);
    const parsed = Papa.parse(content, {/* ... */});

    return {
      data: {
        data: parsed.data,
        columns: parsed.meta.fields,
        rowCount: parsed.data.length,
      },
      metadata: {
        hasHeader: true,
        delimiter: ",",
      },
    };
  },
};
```

**Registry:**

```typescript
// packages/core/src/artifacts/parsers/registry.ts
class ParserRegistry {
  private parsers = new Map<string, FileParser>();

  register<T>(parser: FileParser<T>): void {
    this.parsers.set(parser.mimeType, parser);
  }

  async parse(
    filePath: string,
    mimeType: string,
  ): Promise<ParsedFileResult<unknown>> {
    const parser = this.parsers.get(mimeType);
    if (!parser) {
      throw new Error(`No parser registered for MIME type: ${mimeType}`);
    }
    return parser.parse(filePath);
  }

  hasParser(mimeType: string): boolean {
    return this.parsers.has(mimeType);
  }

  getRegisteredMimeTypes(): string[] {
    return Array.from(this.parsers.keys());
  }
}

export const parserRegistry = new ParserRegistry();
```

**Type Safety:**

```typescript
// Parsing returns unknown - callers should validate with Zod
const result = await parserRegistry.parse(
  artifact.data.path,
  "text/csv",
);
// Validate the result with Zod schema
const csvResult = CsvParseResultSchema.parse(result.data);
// csvResult is now strongly typed as CsvParseResult
```

### 4. Schema Changes

**primitives.ts - Input and Output Schemas:**

```typescript
// OUTPUT: What's stored (always complete)
export const FileDataSchema = z.object({
  path: z.string().describe("Absolute path to the stored file"),
  mimeType: z
    .string()
    .describe("MIME type (e.g., text/csv, application/json). Always populated by storage layer."),
});
export type FileData = z.infer<typeof FileDataSchema>;

// INPUT: Omits fields populated by storage layer
export const FileDataInputSchema = FileDataSchema.omit({ mimeType: true });
export type FileDataInput = z.infer<typeof FileDataInputSchema>;

// REMOVED:
// export const TableDataSchema = z.object({ ... });
```

**model.ts - Separate Creation Schemas:**

```typescript
// OUTPUT schemas for storage (existing)
const FileArtifactSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataSchema,  // Uses OUTPUT schema with required mimeType
});

export const ArtifactDataSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifactSchema,
  CalendarScheduleArtifactSchema,
  SummaryArtifactSchema,
  SlackSummaryArtifactSchema,
  FileArtifactSchema,  // REPLACES TableArtifactSchema
]);

// INPUT schemas for creation - consistent pattern for all types
const WorkspacePlanInputSchema = WorkspacePlanArtifactSchema;
const CalendarScheduleInputSchema = CalendarScheduleArtifactSchema;
const SummaryInputSchema = SummaryArtifactSchema;
const SlackSummaryInputSchema = SlackSummaryArtifactSchema;
const FileArtifactInputSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataInputSchema,  // Uses INPUT schema (omits mimeType)
});

export const ArtifactDataInputSchema = z.discriminatedUnion("type", [
  WorkspacePlanInputSchema,
  CalendarScheduleInputSchema,
  SummaryInputSchema,
  SlackSummaryInputSchema,
  FileArtifactInputSchema,
]);

// Creation schema uses input schemas
export const CreateArtifactSchema = z.object({
  data: ArtifactDataInputSchema,  // Uses INPUT schemas
  summary: z.string().min(1).max(1000),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export type CreateArtifactInput = z.infer<typeof CreateArtifactSchema>;
```

**Example usage:**

```typescript
// Create artifact - minimal input
await ArtifactStorage.create({
  data: {
    type: "file",
    version: 1,
    data: {
      path: "/path/to/file.csv",
      // mimeType NOT allowed in input - will be auto-detected
    },
  },
  summary: "My CSV file",
  workspaceId: "workspace-123",
});

// Stored artifact - complete output
const artifact = {
  id: "uuid",
  type: "file",
  revision: 1,
  data: {
    type: "file",
    version: 1,
    data: {
      path: "/path/to/file.csv",
      mimeType: "text/csv",  // Always present in stored artifacts
    },
  },
  summary: "My CSV file",
  // ...
};
```

### 5. Storage Module Changes

**Imports needed:**

```typescript
import { contentType } from "@std/media-types";
import { extname, join } from "@std/path";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
```

**Helper functions:**

```typescript
// In @atlas/utils/paths.ts
export function getWorkspaceFilesDir(workspaceId: string): string {
  return join(getAtlasHome(), "artifacts", workspaceId);
}

// In storage.ts
function detectMimeType(filePath: string): string {
  const ext = extname(filePath);
  const detected = contentType(ext);
  return detected || "application/octet-stream";
}
```

**Updated create function in storage.ts:**

```typescript
async function create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
  using db = await Deno.openKv(kvPath);

  // Transform input to output by enriching file artifacts with detected metadata
  let artifactData: ArtifactData;

  if (input.data.type === "file") {
    const fileInput = input.data.data;

    // Validate file exists
    try {
      await Deno.stat(fileInput.path);
    } catch (error) {
      return fail(`File not found: ${fileInput.path} (${stringifyError(error)})`);
    }

    // Always detect mimeType (no longer optional)
    const mimeType = detectMimeType(fileInput.path);

    // Create output artifact data with enriched metadata
    artifactData = {
      type: "file",
      version: 1,
      data: {
        path: fileInput.path,
        mimeType,  // Always populated, never undefined
      },
    };
  } else {
    // Other artifact types: input equals output
    artifactData = input.data;
  }

  const id = crypto.randomUUID();
  const revision = 1;

  const artifact: Artifact = {
    id,
    type: artifactData.type,
    revision,
    data: artifactData,  // OUTPUT type with complete metadata
    summary: input.summary,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    createdAt: new Date().toISOString(),
  };

  // Save to KV
  const tx = db.atomic();
  tx.set(keys.artifact(id, revision), artifact);
  tx.set(keys.latest(id), revision);
  // ... rest of KV operations

  return success(artifact);
}
```

**Delete (no cleanup for now):**

```typescript
async function deleteArtifact(
  input: { id: string },
): Promise<Result<void, string>> {
  using db = await Deno.openKv(kvPath);

  const latest = await db.get<number>(keys.latest(input.id));
  if (!latest.value) {
    return fail(`Artifact ${input.id} not found`);
  }

  // Soft delete in KV only
  await db.set(keys.deleted(input.id), new Date());

  // TODO: File cleanup will be added later
  // For now, files remain on disk when artifacts are deleted

  return success(undefined);
}
```

### 6. CSV Tool Changes

**Current API:**

```typescript
{
  csvFiles: string[],  // File paths
  task: string,
  workspaceId: string
}
```

**New API:**

```typescript
{
  csvArtifactIds: string[],  // Artifact IDs, not paths
  task: string,
  workspaceId: string
}
```

**CSV Tool saves transformed results:**

```typescript
// After transformation, write file to workspace directory first
for (const f of parsed) {
  const rows = result.dataByFile[f.fileName] ?? f.data;
  const columns = result.columnsByFile[f.fileName] ?? f.columns;

  // Convert to CSV content
  const csvContent = convertToCsv(columns, rows);

  // Write to workspace files directory (persistent storage)
  const workspaceFilesDir = getWorkspaceFilesDir(input.workspaceId);
  await Deno.mkdir(workspaceFilesDir, { recursive: true });

  const outputFileName = `${crypto.randomUUID()}.csv`;
  const outputPath = `${workspaceFilesDir}/${outputFileName}`;
  await writeFile(outputPath, csvContent, "utf-8");

  // Create artifact pointing to the file (storage detects MIME type and size)
  const createResult = await ArtifactStorage.create({
    data: {
      type: "file",
      version: 1,
      data: {
        path: outputPath,
      },
    },
    summary: `Transformed CSV: ${f.fileName}`,
    workspaceId: input.workspaceId,
  });

  resultArtifactIds.push(createResult.data.id);
}
```

### 7. Migration Strategy

**Breaking Change:**

- Table artifact type is removed from the schema
- Existing table artifacts will fail validation
- No migration provided - users must recreate artifacts

**Impact:**

- Any stored table artifacts become invalid
- CSV tool output changes from table to file artifacts
- Other artifact types (summary, workspace-plan) unchanged

### 8. Testing Strategy

**Unit Tests:**

- File artifact creation (from path, from content)
- File artifact reading with parser registry
- CSV parser
- Atomic transaction rollback (file deleted if KV fails)

**Integration Tests:**

- CSV tool with file artifacts end-to-end
- Multiple CSV operations chained
- Large CSV files (> 1MB)
- Error handling (missing files, invalid artifacts)

**Edge Cases:**

- File deleted but artifact exists (parser should error)
- Artifact deleted but file exists (orphaned files - cleanup later)
- Concurrent artifact creation
- Storage directory doesn't exist (create)
- Invalid extensions
- Missing parser for extension

## Implementation Order

1. **Add file artifact schema** (primitives.ts, model.ts)
2. **Remove table artifact schema** (primitives.ts, model.ts)
3. **Create parser registry** (packages/core/src/artifacts/parsers/)
4. **Add CSV parser** to registry
5. **Update ArtifactStorage** with file support (storage.ts)
6. **Create CSV helper** (convertToCsv function)
7. **Update CSV tool** to use artifacts (index.ts, utils.ts)
8. **Write tests** for each component
9. **Update routes** if needed (artifacts.ts)

## Decisions Made

1. **Input/Output Schema Separation:** Separate schemas for creation vs storage
   - Input schemas (ArtifactDataInputSchema): Minimal data from LLMs/users
   - Output schemas (ArtifactDataSchema): Complete data with enriched metadata
   - Type-safe transformation in storage layer
   - Prevents LLMs from providing incorrect mimeType values

2. **Consistent Input Schemas:** All artifact types have explicit input schemas
   - Most types use same schema as output (aliases for now)
   - File artifacts use `.omit()` to derive input from output schema
   - Maintains consistent pattern across all artifact types
   - Future-proof: easy to add enrichment to any type

3. **Using Zod .omit():** FileDataInputSchema uses `.omit({ mimeType: true })`
   - Single source of truth - changes to FileDataSchema automatically propagate
   - Explicit relationship: input is output minus enriched fields
   - DRY principle: no manual field duplication

4. **MIME type detection:** Required in output, auto-detected from input
   - Storage layer ALWAYS detects MIME type from file extension
   - Uses `@std/media-types` typeByExtension() function
   - Defaults to `application/octet-stream` for unknown extensions
   - LLMs cannot provide mimeType (not in input schema)

5. **File size:** Not stored in artifacts
   - Can be derived with `Deno.stat()` when needed by tools

6. **Original filename:** Removed from schema
   - Use basename of path for display purposes
   - Simplifies schema and avoids redundant data

7. **Extension vs MIME type:** Use MIME type
   - More standardized than file extensions
   - Better for identifying file types unambiguously

8. **Directory structure:** `~/.atlas/artifacts/{workspaceId}/`
   - Groups all workspace artifacts together
   - Easier backup/restore operations
   - Simpler workspace deletion

9. **CSV generation:** Use `Papa.unparse()` instead of manual string concatenation
   - Handles edge cases correctly (quotes, commas, newlines)
   - Consistent with parsing (which uses Papa.parse)
   - Less code to maintain

10. **File permissions:** Workspace files created with `0o600`
    - Owner read/write only
    - No need for global read access on Atlas internal files

## Type Safety Considerations

**Solution:** Parser registry returns `unknown` and callers use Zod validation

```typescript
// Parser returns unknown
const result = await parserRegistry.parse(filePath, mimeType);

// Callers validate with Zod schema for type safety
const csvResult = CsvParseResultSchema.parse(result.data);
// csvResult is now typed as CsvParseResult
```

**Why this approach:**
- Parser registry doesn't make assumptions about types
- Callers explicitly validate data matches expected schema
- Runtime type safety via Zod validation
- Follows project pattern of using Zod for unknown input

## Security Considerations

1. **Path traversal:** Validate artifact paths are within storage directory
2. **File permissions:** All workspace files created with `0o600` (owner read/write only)
   - No need to make Atlas files globally readable
   - Applies to all files in `~/.atlas/artifacts/{workspaceId}/`
3. **Permissions:** Ensure artifacts can't access arbitrary filesystem paths
4. **Storage cleanup:** Not implemented - will add later to remove orphaned files

## Performance Considerations

1. **Large files:** Parser should stream if possible (future optimization)
2. **Caching:** Consider caching parsed results (future optimization)
3. **Parallel loading:** Load multiple artifacts concurrently
4. **File I/O:** All file operations are async

## Summary

This architecture:

- ✅ Solves 64KB KV limit
- ✅ Maintains type safety with parser registry
- ✅ Extension-based parsing (scalable)
- ✅ CSV tool works with artifacts (not raw paths)
- ✅ Atomic operations with rollback
- ✅ Clear separation: KV for metadata, filesystem for data
- ⚠️ Breaking change: removes table artifact type
