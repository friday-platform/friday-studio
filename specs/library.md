# Library System Specification

**Date**: August 27, 2025\
**Feature**: Atlas Library System\
**Type**: Architecture Specification

## 1. Core Purpose

The Atlas Library provides centralized artifact storage and retrieval for all
system-generated content - from AI reports and session archives to user uploads
and templates. It operates as the knowledge repository that agents and users
query to understand previous work, find relevant artifacts, and build upon past
outputs.

## 2. Architecture

### 2.1 Hybrid Storage Model

**Design Principle**: Metadata and content are stored separately for optimal
performance and scalability.

```
┌─────────────────────────────────────────────────────┐
│                Library Storage                      │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────┐    ┌──────────────────────────┐ │
│ │   KV Storage    │    │    Disk Storage          │ │
│ │  (Metadata)     │    │     (Content)            │ │
│ │                 │    │                          │ │
│ │ • Item records  │    │ • Organized by type      │ │
│ │ • Indexes       │    │ • Date hierarchy         │ │
│ │ • Stats         │    │ • Format extensions      │ │
│ │ • Templates     │    │ • ID-based filenames     │ │
│ └─────────────────┘    └──────────────────────────┘ │
│         │                        │                  │
│         └────────┬─────────────────┘                  │
│                  │                                    │
│ ┌─────────────────────────────────────────────────┐  │
│ │        LibraryStorageAdapter                    │  │
│ │ • Atomic operations                             │  │
│ │ • Index management                              │  │
│ │ • Path generation                               │  │
│ │ • Search optimization                           │  │
│ └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 2.2 Content Organization

**Path Structure**: `{type}/{YYYY}/{MM}/{id}.{ext}`

**Example**: `report/2025/08/uuid-123.md`

**Benefits**:

- Fast browsing by type and date
- Predictable file locations
- Automatic cleanup capabilities
- Filesystem efficiency

### 2.3 Index Architecture

**Multi-dimensional indexing** for efficient queries:

```
library/indexes/
├── by_type/{type}/{id} → id
├── by_tag/{tag}/{id} → id  
├── by_workspace/{workspace_id}/{id} → id
└── by_date/{YYYY-MM}/{id} → id
```

## 3. Data Model

### 3.1 Core Types

```typescript
interface LibraryItem {
  id: string; // UUID
  type: ItemType; // Artifact classification
  name: string; // Human-readable name
  description?: string; // Optional summary
  content_path: string; // Relative disk path
  metadata: LibraryItemMetadata;
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
  tags: string[]; // User/agent tags
  size_bytes: number; // Content size
  workspace_id?: string; // Optional workspace scope
}

type ItemType =
  | "report" // AI analysis outputs
  | "session_archive" // Complete session logs
  | "template" // Reusable content templates
  | "artifact" // General AI outputs
  | "user_upload"; // User-provided content
```

### 3.2 Metadata Structure

```typescript
interface LibraryItemMetadata {
  mime_type: string; // Standard MIME type
  source: ContentSource; // Origin system
  session_id?: string; // Originating session
  agent_ids?: string[]; // Contributing agents
  template_id?: string; // Source template
  generated_by?: string; // Specific generator
  custom_fields?: Record<string, any>; // Extensible
}

type ContentSource = "agent" | "job" | "user" | "system";
```

### 3.3 MIME Type Support

**Design Principle**: Use standard MIME types with comprehensive extension
mapping for practical file storage.

**Supported MIME Types**:

```typescript
// Comprehensive MIME type to extension mapping
const MIME_TO_EXTENSION = {
  // Text formats (most text files use text/plain with specific extensions)
  "text/plain": "txt", // Default for text/plain
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",

  // Application text formats
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yml",
  "application/x-javascript": "js",

  // Images
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",

  // Video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",

  // Audio
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/webm": "weba",

  // Applications
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/x-executable": "bin",
  "application/x-mach-binary": "dmg",
  "application/x-msdownload": "exe",
} as const;

// Extension-based MIME type detection for text/plain files
const EXTENSION_TO_MIME = {
  // Programming languages (all stored as text/plain with specific extensions)
  "md": "text/plain",
  "markdown": "text/plain", 
  "ts": "text/plain",
  "js": "text/plain",
  "py": "text/plain",
  "go": "text/plain",
  "rs": "text/plain",
  "java": "text/plain",
  "cpp": "text/plain",
  "c": "text/plain",
  "h": "text/plain",
  "sh": "text/plain",
  "rb": "text/plain",
  "php": "text/plain",
  "swift": "text/plain",
  "kt": "text/plain",
  "scala": "text/plain",
  "r": "text/plain",
  "sql": "text/plain",
  
  // Config files
  "yml": "text/plain",
  "yaml": "text/plain", 
  "toml": "text/plain",
  "ini": "text/plain",
  "conf": "text/plain",
  "env": "text/plain",
  
  // Other text formats
  "txt": "text/plain",
  "log": "text/plain",
  "readme": "text/plain",
} as const;

type SupportedMimeType = keyof typeof MIME_TO_EXTENSION | string; // Known types + fallback
```

**MIME Type Processing**:

- **Known Types**: Use explicit extension mapping for supported MIME types
- **Text/Plain with Extension**: For `text/plain` content, use filename extension to determine storage extension
- **Extension Detection**: When MIME type is empty or `""`, detect from filename extension
- **Unknown Types**: Accept any MIME type, use generic `.dat` extension
- **No Validation**: Accept any MIME type since storage is local and trusted

**Processing Logic**:
- `"text/plain"` + filename `"code.md"` → stored as `id.md`
- `"text/plain"` + filename `"script.ts"` → stored as `id.ts` 
- `""` (empty) + filename `"README.md"` → MIME becomes `"text/plain"`, stored as `id.md`
- `"application/json"` → stored as `id.json` (from MIME mapping)

## 4. API Interface

### 4.1 REST Endpoints

**Base Path**: `/library`

| Method | Path                       | Purpose                |
| ------ | -------------------------- | ---------------------- |
| POST   | `/`                        | Create item            |
| GET    | `/{id}`                    | Retrieve item metadata |
| GET    | `/{id}/content`            | Retrieve with content  |
| DELETE | `/{id}`                    | Delete item            |
| POST   | `/search`                  | Search items           |
| GET    | `/stats`                   | System statistics      |
| GET    | `/templates`               | List templates         |
| POST   | `/templates/{id}/generate` | Generate from template |

### 4.2 Content Format Migration

**Current Issue**: Legacy `format` field uses limited enum, new `mime_type`
field uses standard MIME types.

**Updated Creation Request**:

```typescript
{
  type: string,
  name: string,
  content: string | Uint8Array,  // Support binary content
  mime_type?: string,             // MIME type (auto-detected if omitted/empty)
  filename?: string,              // Original filename for extension detection
  source?: string,                // Default: "agent" 
  session_id?: string,
  agent_ids?: string[],
  tags?: string[],
  metadata?: Record<string, any>  // Extensible fields
}
```

**Updated Storage Interface**:

```typescript
{
  id: string,               // Generated UUID
  created_at: string,       // Generated timestamp
  updated_at: string,       // Generated timestamp  
  metadata: {               // Structured composition
    mime_type: string,      // Standard MIME type
    source: ContentSource,
    session_id?: string,
    agent_ids?: string[],
    template_id?: string,
    generated_by?: string,
    custom_fields?: Record<string, any>
  }
}
```

### 4.3 Content Handling by Type

**Text Content** (`content: string`):

- MIME types: `text/*`, `application/json`, `application/xml`,
  `application/yaml`
- Storage: UTF-8 encoded text files
- Retrieval: Return as string with appropriate Content-Type header

**Binary Content** (`content: Uint8Array`):

- MIME types: `image/*`, `video/*`, `audio/*`, `application/*` (non-text)
- Storage: Raw binary files
- Retrieval: Return as binary with appropriate Content-Type and
  Content-Disposition headers

**MIME Type Detection**:

```typescript
function detectMimeType(
  content: string | Uint8Array,
  filename?: string,
  providedMimeType?: string,
): string {
  // 1. Use provided MIME type if valid and not empty
  if (providedMimeType && providedMimeType.trim() !== "") {
    return providedMimeType.trim();
  }
  
  // 2. For empty/missing MIME type, detect from filename extension
  if (filename) {
    const ext = getFileExtension(filename);
    if (EXTENSION_TO_MIME[ext]) {
      return EXTENSION_TO_MIME[ext];
    }
  }
  
  // 3. Check content signatures (magic bytes) for binary content
  if (content instanceof Uint8Array) {
    const detected = detectFromMagicBytes(content);
    if (detected) return detected;
  }
  
  // 4. Analyze content structure for text formats (JSON, XML, etc.)
  if (typeof content === "string") {
    if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
      return "application/json";
    }
    if (content.trim().startsWith("<")) {
      return "application/xml";
    }
  }
  
  // 5. Defaults
  return content instanceof Uint8Array ? "application/octet-stream" : "text/plain";
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : "";
}
```

## 5. Storage Operations

### 5.1 Item Storage

**Updated Process**:

1. Validate input against schema
2. **Detect MIME type** from content and optional filename
3. Generate ID and timestamps
4. Calculate content size
5. **Generate file path with MIME-based extension**
6. Write content to disk (text as UTF-8, binary as-is)
7. Store metadata in KV with indexes
8. Atomic commit - rollback on failure

**MIME-Based Path Generation**:

```typescript
function generateContentPath(
  id: string,
  type: string,
  mimeType: string,
  createdAt: string,
): string {
  const extension = getExtensionForMimeType(mimeType); // .jpg, .pdf, .mp4, etc.
  const filename = `${id}.${extension}`;

  // Organize: type/YYYY/MM/id.ext
  const date = new Date(createdAt);
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");

  return join(type, year, month, filename);
}

function getExtensionForMimeType(mimeType: string, filename?: string): string {
  // For text/plain, use filename extension if available
  if (mimeType === "text/plain" && filename) {
    const ext = getFileExtension(filename);
    if (ext && EXTENSION_TO_MIME[ext] === "text/plain") {
      return ext; // Use original extension (md, ts, go, etc.)
    }
  }
  
  // Use known mapping if available
  if (MIME_TO_EXTENSION[mimeType]) {
    return MIME_TO_EXTENSION[mimeType];
  }

  // Fallback for unknown MIME types
  return "dat";
}
```

**Atomic Safety**: Content cleanup on KV failure prevents orphaned files.

### 5.2 Retrieval Patterns

**Metadata Only** (`getItem`):

- Fast KV lookup
- No disk access
- Returns MIME type for client handling
- Used for listings/search results

**With Content** (`getItemWithContent`):

- KV lookup for metadata
- Disk read for content
- **MIME-aware content handling**:
  - Text MIME types → read as UTF-8 string
  - Binary MIME types → read as Uint8Array
- Returns appropriate Content-Type header
- Used for full item access

**Content-Type Headers**:

```typescript
function getContentTypeHeader(mimeType: string): string {
  // Use detected MIME type directly
  return mimeType;
}

function getContentDisposition(name: string, mimeType: string): string {
  // Inline for viewable content, attachment for downloads
  const viewable = mimeType.startsWith("text/") ||
    mimeType.startsWith("image/") ||
    mimeType === "application/json";

  return viewable
    ? `inline; filename="${name}"`
    : `attachment; filename="${name}"`;
}
```

### 5.3 Search Implementation

**Index-Based Optimization**:

1. Use indexes when available (type, tags, workspace, date)
2. Intersection for multiple filters
3. Full scan fallback for complex queries
4. Post-filter for text search and date ranges
5. Sort by creation date (newest first)
6. Paginate results

**Performance**: Sub-100ms for indexed queries, scales with content size for
full-text.

## 6. Templates System

### 6.1 Template Architecture

**Separation**: Templates stored separately from library items in dedicated
namespace.

**Structure**:

```
library/templates/
├── global/{template_id} → TemplateConfig
└── {workspace_id}/{template_id} → TemplateConfig
```

**Hierarchy**: Workspace templates override global templates.

### 6.2 Template Engine Interface

```typescript
interface ITemplateEngine {
  type: string;
  canHandle(template: TemplateConfig): boolean;
  apply(template: TemplateConfig, data: any): Promise<string>;
  validate(template: TemplateConfig): ValidationResult;
}
```

**Registry Pattern**: Pluggable template engines (Mustache, Handlebars, etc.)

## 7. Configuration

### 7.1 Storage Configuration

```typescript
interface LibraryStorageConfig {
  contentDir?: string; // Default: XDG-compliant path
  organizeByType?: boolean; // Default: true
  organizeByDate?: boolean; // Default: true
  extensionMap?: Record<string, string>; // Format → extension
}
```

### 7.2 Platform Defaults

**Storage Location**:

- **macOS**: `~/Library/Application Support/Atlas/library`
- **Linux**: `~/.local/share/atlas/library`
- **Windows**: `%LOCALAPPDATA%/Atlas/library`
- **Fallback**: `./.atlas/library`

## 8. Performance Characteristics

### 8.1 Benchmarks

| Operation          | Target | Implementation         |
| ------------------ | ------ | ---------------------- |
| Create item        | <100ms | Atomic KV + disk write |
| Get metadata       | <10ms  | Single KV lookup       |
| Get with content   | <50ms  | KV + disk read         |
| Search (indexed)   | <100ms | Index intersection     |
| Search (full-text) | <500ms | Content scanning       |

### 8.2 Scaling Considerations

**Storage Growth**: Content on disk scales linearly, metadata in KV remains fast
**Index Size**: Grows with item count, rebuild capability available **Concurrent
Access**: KV atomic operations handle concurrency **Cleanup**: Date-based
organization enables efficient retention policies

## 9. Integration Points

### 9.1 Agent Integration

**Store Results**: Agents use library to persist reports, analyses, artifacts
**Query Context**: Agents search library for relevant previous work **Template
Usage**: Agents generate content from templates

### 9.2 Session Integration

**Archive Storage**: Complete session logs stored as session_archive items
**Cross-Session Context**: Library enables learning from previous sessions
**User Continuity**: Users can reference and build on past work

### 9.3 Workspace Integration

**Scoped Storage**: Items can be workspace-specific or global **Workspace
Templates**: Template inheritance with workspace override **Resource Sharing**:
Cross-workspace item access when appropriate

## 10. Error Handling

### 10.1 Failure Modes

**Content Write Failure**: KV rollback prevents orphaned metadata **KV
Failure**: Content cleanup prevents orphaned files\
**Index Corruption**: Rebuild capability from authoritative item records **Disk
Full**: Graceful degradation with clear error messages

### 10.2 Recovery Procedures

**Index Rebuild**: `updateIndex()` reconstructs all indexes from items **Orphan
Cleanup**: Compare disk content with KV metadata **Consistency Check**: Validate
metadata matches actual files **Migration**: Version-aware upgrades for schema
changes

## 11. Security Model

### 11.1 Access Control

**Current**: No authentication - assumes trusted environment **Future**:
Workspace-based permissions, user isolation **File System**: Standard OS
permissions on content directory

### 11.2 Data Validation

**Input Sanitization**: Zod schemas validate all inputs **MIME Type
Processing**: Accept any MIME type, sanitize format **Path Safety**: Generated
paths prevent directory traversal **Content Limits**: Size restrictions prevent
resource exhaustion

**MIME Type Sanitization**:

```typescript
function sanitizeMimeType(userMimeType: string): string {
  // Basic sanitization - no validation since local storage is trusted
  const sanitized = userMimeType.toLowerCase().trim();

  // Ensure proper format
  if (!sanitized.includes("/")) {
    throw new Error(`Invalid MIME type format: ${sanitized}`);
  }

  // Remove any dangerous characters for file paths
  const [type, subtype] = sanitized.split("/");
  const cleanSubtype = subtype.replace(/[^a-z0-9.-]/g, "");

  return `${type}/${cleanSubtype}`;
}
```

**No Content Validation**: Since storage is local and trusted, we don't validate
content against declared MIME types - accept user input as authoritative.

## 12. Development Patterns

### 12.1 Type Safety

**Legacy Problem**: Creation schema uses `z.any()` metadata field **MIME
Migration**: Replace `format` enum with standard `mime_type` field **Impact**:
Runtime errors possible despite TypeScript **Solution**: Structured metadata
composition with MIME type validation

**Updated Validation Schema**:

```typescript
export const createLibraryItemSchema = z.object({
  type: LIBRARY_ITEM_TYPE,
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.union([z.string(), z.instanceof(Uint8Array)]), // Binary support
  mime_type: z.string().optional(), // Auto-detected if omitted
  source: LIBRARY_SOURCE.optional().default("agent"),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().default([]),
  workspace_id: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(), // Extensible fields only
});
```

### 12.2 Error Patterns

```typescript
// Good: Structured errors with context
throw new Error(`Failed to read content for item ${id}: ${error.message}`);

// Bad: Generic errors
throw new Error("Content read failed");
```

### 12.3 Testing Approach

**Unit Tests**: Individual storage operations **Integration Tests**: Full
create/retrieve/search workflows\
**Performance Tests**: Large dataset operations **Failure Tests**: Error
conditions and recovery

## 13. Future Considerations

### 13.1 Planned Enhancements

**Full-Text Search**: Integrated content indexing for better search
**Versioning**: Item history tracking and rollback capability **Compression**:
Content compression for large items **Encryption**: At-rest encryption for
sensitive content **Replication**: Multi-node storage for high availability

### 13.2 API Evolution

**GraphQL**: Rich query interface for complex searches **Streaming**: Large
content streaming for performance **Subscriptions**: Real-time updates for
collaborative features **Bulk Operations**: Efficient batch import/export

### 13.3 Integration Expansion

**External Storage**: S3/GCS backends for cloud deployment **Search Engines**:
Elasticsearch integration for advanced queries **CDN Integration**: Content
distribution for web clients **Backup Systems**: Automated backup and disaster
recovery

## 14. Implementation Status

### 14.1 Completed

- ✅ Hybrid storage architecture
- ✅ Multi-dimensional indexing
- ✅ Atomic operations
- ✅ Template system foundation
- ✅ REST API endpoints
- ✅ XDG-compliant storage paths
- ✅ Error handling and recovery
- ✅ Content organization

### 14.2 Known Issues

- ❌ **Legacy Content Format**: Limited enum instead of MIME types
- ❌ **Binary Content Gap**: No support for images, video, audio, applications
- ❌ **Type Safety Gap**: Creation schema → storage interface mismatch
- ❌ **Validation Inconsistency**: Loose `z.any()` metadata typing
- ❌ **Search Limitations**: Workspace filtering not fully implemented
- ❌ **Template Engine Registry**: Missing pluggable engine system

### 14.3 MIME Type Migration Priorities

1. **MIME Type Implementation**: Replace `format` field with `mime_type` in
   schemas and storage
2. **Binary Content Support**: Enable `string | Uint8Array` content handling
3. **Extension Mapping**: Implement comprehensive MIME type → extension mapping
4. **HTTP Headers**: Proper Content-Type and Content-Disposition headers for
   retrieval
5. **Migration Path**: Graceful upgrade from legacy format enum to MIME types
6. **Simplified Processing**: Remove content validation - trust user-provided
   MIME types
7. **Fallback Handling**: Unknown MIME types use `.dat` extension

### 14.4 Additional Priorities

1. **Enhanced Search**: Implement full workspace filtering
2. **Performance Testing**: Validate scaling with binary content
3. **Storage Optimization**: Efficient handling of large binary files
4. **API Documentation**: Updated schemas with MIME type examples

---

This specification establishes Atlas Library as the central knowledge repository
that enables agents and users to build upon previous work systematically. The
hybrid storage model balances performance with scalability, while the
multi-dimensional indexing ensures efficient retrieval across diverse query
patterns.

**Critical Migration Need**: The current limited content format system must
evolve to support MIME types and binary content. This enables the library to
handle the full spectrum of content types that Atlas agents and users will
generate - from traditional text reports to images, videos, PDFs, and executable
artifacts.

The MIME type migration addresses both the immediate need for broader content
support and the long-term architectural goal of standards-based content handling
that integrates seamlessly with web clients and external systems.
