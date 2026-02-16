# Image Upload Support

Shipped February 2026 on branch `support-images`.

Friday supports uploading text files and document formats (PDF, DOCX, PPTX) —
documents get converted to markdown and injected as text. Images can't work that
way. This feature adds native image upload (PNG, JPEG, WebP, GIF) that stores
original binaries and injects them as `ImagePart` objects into LLM content
arrays. Images flow through two injection points: the conversation agent (via
message windowing) and the FSM engine (via a refactored LLMProvider interface).

## What Changed

### Upload Pipeline (`file-upload.ts`)

- Added `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` to `EXTENSION_TO_MIME`
- Added image MIME types to binary detection allowlist (magic byte check)
- 5MB size limit via `MAX_IMAGE_SIZE` — matches Anthropic's per-image API limit
- No conversion step — store original binary as-is (unlike PDF/DOCX → markdown)
- Artifact: `type: "file"` with `data: { path, mimeType, originalName }`
- Summary: filename placeholder `"Image: {originalName}"` — no LLM
  summarization. `smallLLM()` is text-only and may lack vision

### Storage Adapter

- Added `readBinaryContents(id, revision?)` to `ArtifactStorageAdapter`
  interface, returning `Promise<Result<Uint8Array>>`
- Local adapter: `readFile(path)` returns `Uint8Array`
- Cortex adapter: exposed existing private `downloadBinaryBlob(cortexId)`
- `Uint8Array` passed directly to AI SDK's `ImagePart` — SDK handles base64
  encoding per provider

### Shared Image Resolution (`resolveImageParts`)

Both conversation agent and FSM engine need: given artifact IDs with image MIME
types, read binary data, produce `ImagePart[]`. Extracted a shared helper.

- Reads binary via `readBinaryContents()`, returns `ImagePart[]`
- Graceful degradation: read failure → text fallback
  `[Image: filename — could not be loaded]`
- Lives in a shared location accessible to both `message-windowing.ts` and
  `fsm-engine.ts`

### Conversation Agent (Message Windowing)

- `expandArtifactAttachedParts()` in `message-windowing.ts` detects image
  artifacts, produces `ImagePart` objects in message content arrays
- `data-artifact-attached` event schema enriched with `mimeTypes?: string[]` at
  upload time — avoids runtime artifact lookups during expansion
- Client sends `mimeTypes: artifacts.map(a => a.data.mimeType)` in the event
  payload alongside `artifactIds` and `filenames`
- Token estimation: fixed ~1600 tokens per `ImagePart` in `estimateTokens()`.
  Does NOT stringify binary data. 1600 comes from Anthropic's vision formula:
  `(width * height) / 750`, images auto-resize to 1568px longest edge

### FSM Engine (LLMProvider Refactor)

- Added optional `messages` parameter to `LLMProvider.call()` as alternative to
  `prompt: string`
- `AtlasLLMProviderAdapter`: when `messages` present, uses
  `generateText({ messages })`; when absent, existing `prompt` path unchanged
- `buildContextPrompt()` return type changed from `string` to
  `{ prompt: string; images: Array<{ data: Uint8Array; mediaType: string }> }`
- After artifact expansion, detects image artifacts by `mimeType`, uses
  `resolveImageParts()` for binary read
- FSM LLM action handler assembles `messages` array from prompt + images when
  images exist, falls back to `call({ prompt })` otherwise
- Workspace runtime benefits automatically — same adapter and engine

### Web Client — Binary Content Endpoint

- `GET /artifacts/:id/content` in `artifacts.ts` route — reads binary via
  `readBinaryContents()`, streams with correct `Content-Type` header
- Works for both local and Cortex storage
- General-purpose file serving endpoint, useful beyond images

### Web Client — Inline Display

- Extended `artifact-attached.svelte` — for each file, checks `mimeType`:
  `image/*` → `<img>` tag; otherwise → existing green chip
- Image `src` hits `/api/artifacts/{id}/content`
- Constrained to `max-inline-size: 400px`, right-aligned like user messages,
  filename caption below
- `onerror` fallback: hide image, show chip instead
- Multiple images stack vertically with gap
- Updated `ArtifactAttachedEntry` type with `mimeTypes?: string[]`
- Added `mimeTypes` to agent-sdk `artifact-attached` data event schema
  (`.optional()` for backward compat with legacy messages)
- `format.ts` threads `mimeTypes` through the `data-artifact-attached` handler
- No new component, no `formatMessage` signature change, no new entry type

### Error Handling

- Unsupported formats (SVG, BMP, TIFF, HEIC): rejected by `EXTENSION_TO_MIME`
  with `"Unsupported image format. Supported: PNG, JPEG, WebP, GIF."`
- Over 5MB: rejected with `"Image files must be under 5MB."`
- Missing file at prompt assembly: degrades to text note, never crashes
- Browser `<img>` load failure: broken image → falls back to chip via `onerror`

## Key Decisions

**Image expansion happens at message-building time, not in the artifact
expansion layer.** `expandArtifactRefsInDocuments()` stays text-only. Rationale:

- `buildContextPrompt()` originally returned a string — can't carry `Uint8Array`
- Loading binaries during generic artifact expansion is wasteful when not every
  FSM step needs images
- Message building is where you're already constructing AI SDK format — natural
  place for multimodal content

**Tracer bullet approach.** Built conversation agent path end-to-end first
(upload → store → display → inject → LLM response), then expanded to FSM
engine. Both shipped in a single PR.

**No LLM summarization for image artifacts.** `smallLLM()` is text-only and uses
a model that may lack vision. Filename placeholder is sufficient.

**5MB limit, not configurable.** Matches Anthropic API per-image limit directly.

## Out of Scope

- SVG, BMP, TIFF, HEIC, AVIF support
- Image thumbnails in chat attachment chips
- Lightbox / full-size image viewer
- Image editing or annotation
- LLM-generated image summaries
- FSM `executeAgent()` path seeing images (separate concern from LLM actions)
- Chunked upload for images (capped at 5MB, well below 50MB threshold)
- Image compression or resizing (providers handle internally)
- Multiple images per message UX (architecture supports it, not explicitly
  designed)

## Test Coverage

- `file-upload.ts` — image extensions, size limits, binary magic bytes,
  unsupported format rejection
- `message-windowing.ts` — `expandArtifactAttachedParts()` produces `ImagePart`
  for images, text for non-image, graceful degradation. `estimateTokens()`
  returns ~1600 for `ImagePart`
- `resolveImageParts()` — binary read, correct ImagePart, fallback on failure
- `llm-provider-adapter.ts` — `messages` param → `generateText({ messages })`,
  absent → `generateText({ prompt })`
- `artifacts.ts` route — upload creates correct artifact, `/content` endpoint
  returns binary with correct Content-Type, 404 for missing
- Integration: upload PNG → 201, oversized → 413, `.bmp` → 415
- Test fixtures: 1x1 pixel PNG, tiny JPEG (minimal binary fixtures)
- `format.test.ts` — `mimeTypes` preserved in entry, undefined for legacy
