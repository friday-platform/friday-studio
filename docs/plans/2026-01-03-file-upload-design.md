# File Upload Design

> **Status:** Implemented (2026-01-04)
>
> This document is the source of record for the file upload feature. It reflects
> what was actually built, not the original proposal.

## Overview

Replace filepath-based file attachments with true file uploads. Files are
uploaded as artifacts immediately on drop, and artifact IDs are passed to the
LLM instead of local paths.

## Background

The original implementation stored local filesystem paths when users
drag-and-drop files. This approach fundamentally broke for a hosted platform:

- **Browser drag-and-drop provides File objects, not paths** - browsers can't
  expose filesystem paths for security reasons
- **Daemon cannot access user filesystems remotely** - local paths are
  meaningless when daemon runs on a different machine
- **Tauri is being retired** - browser-only is the future

### Solution

The web client uses HTML5 drag-and-drop which provides `File` objects directly.
Files are uploaded immediately on drop via multipart POST to the daemon, stored
persistently, and referenced by artifact ID in messages.

---

## Server Implementation

### Upload Endpoint

**Location:** `apps/atlasd/routes/artifacts.ts`

`POST /api/artifacts/upload` accepts multipart form data:

```typescript
.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return c.json({ error: "file field is required and must be a File" }, 400);
  }

  const chatId = formData.get("chatId")?.toString() || undefined;

  // ... validation and storage logic
  return c.json({ artifact }, 201);
})
```

**Request:**

- `file`: File (required) - actual file bytes, max 25MB
- `chatId`: string (optional) - associate with existing chat. If omitted,
  artifact is stored in `orphan/` directory.

**Response (success):**

```json
{ "artifact": Artifact }
```

**Response (error):**

```json
{ "error": "File too large (max 25MB)" }
{ "error": "File type not allowed. Supported: CSV, JSON, TXT, MD" }
{ "error": "Upload failed" }
```

**HTTP Status Codes:**

- `201` - Success
- `400` - Invalid request (missing file, wrong content-type, invalid chatId)
- `413` - File too large
- `415` - Unsupported media type
- `500` - Server error

### Upload Flow

1. Parse multipart form data, extract `File` object
2. Validate file size (< 25MB) - return 413 if exceeded
3. Detect MIME type (prefer `file.type`, fallback to extension)
4. Validate MIME type against allowlist - return 415 if disallowed
5. Sanitize `chatId` (reject if contains `..` or starts with `/`)
6. Generate storage path: `~/.atlas/uploads/{chatId || 'orphan'}/{uuid}.{ext}`
7. Create directory if needed
8. Write bytes to storage path (persistent, not temp)
9. Call `ArtifactStorage.create()` with storage path, title, and summary
10. Return created artifact

**Storage directory structure:**

```
~/.atlas/
  uploads/
    {chatId}/           # Chat-associated uploads
      {uuid}.csv
      {uuid}.json
    orphan/             # Unattached uploads (new chat page)
      {uuid}.txt
```

### Validation

```typescript
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const ALLOWED_EXTENSIONS = new Map([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
]);

const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/json",
  "text/markdown",
  "text/x-markdown",
]);
```

Browser-provided `file.type` is unreliable (can be empty or
`application/octet-stream`), so we fall back to extension-based detection.

### Supported File Types

Only text-based files are allowed: **CSV, JSON, TXT, and MD**.

**Why text-only?**

1. **Security** - Text files are inherently safe to read and display. Binary
   files (executables, archives, images) carry security risks and require
   sandboxed rendering we don't have yet.

2. **Agent capability** - The `artifacts_get` tool returns file contents inline
   as text in a single tool call. Binary files would require base64 encoding or
   streaming, adding complexity without clear use cases today.

3. **MVP scope** - These four formats cover the primary agent use cases:
   - **CSV**: Data analysis, spreadsheets, exports
   - **JSON**: API responses, configs, structured data
   - **TXT**: Logs, notes, plain text content
   - **MD**: Documentation, formatted content

4. **Storage efficiency** - Text files compress well. Binary uploads would need
   different storage strategies (deduplication, CDN distribution, etc).

**Future expansion** should be driven by concrete user requests, not speculation.
When adding new types, consider: How will the agent consume this file? Does
`artifacts_get` need to change? What security review is needed?

### Artifact Metadata

When creating the artifact:

- `title`: original filename (e.g., `"sales-q4.csv"`)
- `summary`: `"Uploaded file: {filename}"`
- `data.originalName`: original filename (preserved for UI display)
- `data.source`: `"upload"` (for future targeted cleanup)

### Inline File Contents

**Location:** `GET /api/artifacts/:id`

File artifact responses now include contents inline:

```typescript
.get("/:id", async (c) => {
  const artifact = await ArtifactStorage.get({ id });

  let contents: string | undefined;
  if (artifact.data.type === "file") {
    const contentsResult = await ArtifactStorage.readFileContents({ id });
    if (contentsResult.ok) {
      contents = contentsResult.data;
    }
  }

  return c.json({ artifact, contents }, 200);
})
```

This eliminates the need for a separate `artifacts_read_contents` tool - the
`artifacts_get` MCP tool now returns file contents directly, enabling agents to
answer "what's in that file?" with a single tool call.

**Readable MIME types:**

```typescript
const READABLE_MIME_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);
```

Binary files return `undefined` for contents (metadata still returned).

---

## Client Implementation

### StagedFile Type

**Location:** `apps/web-client/src/lib/app-context.svelte.ts`

```typescript
interface StagedFile {
  id: string; // Unique key - generated by add()
  artifactId?: string; // Populated after successful upload
  name: string; // Original filename
  size: number; // File size in bytes for display
  status: "uploading" | "ready" | "error";
  error?: string; // Error message if status === "error"
}
```

### State Management

```typescript
function createStagedFiles() {
  const state = new SvelteMap<string, StagedFile>();

  return {
    get state() {
      return state;
    },

    add: (file: Omit<StagedFile, "id">): string => {
      const id = crypto.randomUUID();
      state.set(id, { id, ...file });
      return id;
    },

    update: (
      id: string,
      updates: Partial<Pick<StagedFile, "artifactId" | "status" | "error">>,
    ) => {
      const existing = state.get(id);
      if (existing) {
        state.set(id, { ...existing, ...updates });
      }
    },

    remove: (id: string) => {
      state.delete(id);
    },

    clear: () => {
      state.clear();
    },
  };
}
```

### Client-Side Validation

```typescript
function validateFile(file: File): { valid: true } | { valid: false; error: string } {
  if (file.size > 25 * 1024 * 1024) {
    return { valid: false, error: "File too large. Maximum size is 25MB." };
  }

  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) {
    return { valid: true };
  }

  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: true };
  }

  return {
    valid: false,
    error: "Unsupported file type. Only CSV, JSON, TXT, and MD files are allowed.",
  };
}
```

### Upload Function

```typescript
async function uploadFile(
  file: File,
  chatId?: string,
): Promise<{ artifactId: string } | { error: string }> {
  const formData = new FormData();
  formData.set("file", file);
  if (chatId) formData.set("chatId", chatId);

  try {
    const response = await fetch("/api/artifacts/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { error: data.error || `Upload failed (${response.status})` };
    }

    const { artifact } = await response.json();
    return { artifactId: artifact.id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Network error" };
  }
}
```

### Drop Handler

```typescript
async function handleFileDrop(files: File[], chatId?: string) {
  for (const file of files) {
    const validation = validateFile(file);
    if (!validation.valid) {
      appCtx.stagedFiles.add({
        name: file.name,
        size: file.size,
        status: "error",
        error: validation.error,
      });
      continue;
    }

    const tempId = appCtx.stagedFiles.add({
      name: file.name,
      size: file.size,
      status: "uploading",
    });

    // Fire and forget - uploads run in parallel
    uploadFile(file, chatId).then((result) => {
      if ("artifactId" in result) {
        appCtx.stagedFiles.update(tempId, {
          artifactId: result.artifactId,
          status: "ready",
        });
      } else {
        appCtx.stagedFiles.update(tempId, {
          status: "error",
          error: result.error,
        });
      }
    });
  }
}
```

### HTML5 Drop Handlers

**Locations:**

- `apps/web-client/src/routes/(app)/+page.svelte` (new chat)
- `apps/web-client/src/routes/(app)/chat/[chatId]/+page.svelte` (existing chat)

```svelte
<div
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => {
    e.preventDefault();
    handleFileDrop(Array.from(e.dataTransfer?.files || []), chatId);
  }}
>
```

### Submit Handler

1. Disable submit button while any file has `status: "uploading"`
2. Only include files with `status: "ready"` in message
3. Clear ALL staged files after send (including errors)

```typescript
const hasUploadingFiles = Array.from(appCtx.stagedFiles.state.values()).some(
  (f) => f.status === "uploading",
);

const readyFiles = Array.from(appCtx.stagedFiles.state.values()).filter(
  (f) => f.status === "ready" && f.artifactId,
);

let combinedMessage = message;
if (readyFiles.length > 0) {
  combinedMessage += "\n\nAttachments:";
  for (const file of readyFiles) {
    combinedMessage += `\n- artifact:${file.artifactId}`;
  }
}
```

---

## UI Display

| Status      | Display                                          |
| ----------- | ------------------------------------------------ |
| `uploading` | Spinner + filename + formatted size              |
| `ready`     | Checkmark + filename + formatted size            |
| `error`     | Error icon + filename + error message + X button |

---

## Message Format

```
User's message

Attachments:
- artifact:abc-123-def
```

The `artifact:` prefix tells the LLM this is an artifact reference. Agent uses
`artifacts_get` to retrieve both metadata and contents in a single call.

---

## Files Changed

| File                                                          | Change                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/atlasd/routes/artifacts.ts`                             | Add `POST /upload`, update `GET /:id` to include contents      |
| `packages/core/src/artifacts/local-adapter.ts`                | Expand `READABLE_MIME_TYPES`, fix error message                |
| `packages/core/src/artifacts/primitives.ts`                   | Allow `originalName` in `FileDataInputSchema`                  |
| `packages/mcp-server/src/tools/artifacts/get.ts`              | Pass through `contents` field                                  |
| `apps/web-client/src/lib/app-context.svelte.ts`               | New `StagedFile` type, `createStagedFiles()` with state machine|
| `apps/web-client/src/routes/(app)/+page.svelte`               | HTML5 drop handlers, submit logic                              |
| `apps/web-client/src/routes/(app)/chat/[chatId]/+page.svelte` | HTML5 drop handlers, submit logic                              |
| `src/core/agents/conversation.ts`                             | Enable `artifacts_get` tool, add system prompt instructions    |

---

## Known Limitations

- **Tauri picker broken** - files added via Tauri picker have no `artifactId`,
  silently dropped on submit. Tauri is being retired.
- **No orphan cleanup** - files uploaded but never attached persist in
  `~/.atlas/uploads/orphan/`. Acceptable tech debt.
- **No retry logic** - user must dismiss and re-drop on failure.

---

## Out of Scope (Deferred)

- Folder uploads
- Upload progress indicators (percentage)
- Retry logic for failed uploads
- Orphaned artifact cleanup
- Concurrent upload limits (browser handles this)
- Duplicate file detection
