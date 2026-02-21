# Artifact Upload in Run Job Modal

Shipped 2026-02-20 on `eric/upload-in-run-job`.

When a workspace signal schema includes `format: "artifact-ref"` on a string
property, the Run Job modal renders a file upload dropzone instead of a text
input. Users drop a file, it uploads and converts, and the resulting artifact ID
populates the signal payload automatically. This replaces the old workaround of
uploading via chat and manually triggering the job.

## What Changed

### `$lib/components/artifact-ref-input.svelte` (new)

Self-contained file upload dropzone with a 5-state machine:
idle, uploading, converting, ready, error. Manages its own AbortController for
cancellation. Fires `onchange(artifactId)` on success,
`onchange(undefined)` on cancel/error. Exposes a `$bindable uploading` prop so
the parent dialog can track in-flight uploads without knowing internal state.

### `$lib/utils/upload.ts` (extracted from `app-context.svelte.ts`)

Moved `validateFile`, `uploadFile`, `uploadFileSimple`, `uploadFileChunked`, and
supporting Zod schemas out of the chat-specific app context into a shared
module. Both the chat flow (`handleFileDrop`) and the modal import from here.
Zero reactive dependencies — pure functions and XHR/fetch wrappers.

### `run-job-dialog.svelte` (modified)

Extended `FieldDef` with `format` and `title` fields. Routes
`format: "artifact-ref"` + `type !== "array"` to `ArtifactRefInput`. Tracks
per-field upload state via `Record<string, boolean>` bound to each component's
`uploading` prop, derives `hasUploadsInProgress` to gate the Run button. Field
labels use JSON Schema `title` when available, falling back to humanized field
keys (`csv_artifact` becomes "Csv artifact").

### `$lib/utils/files.svelte.ts` (new)

`formatFileSize(bytes)` utility for human-readable file sizes in the upload UI.

## Key Decisions

**`$bindable uploading` prop over status callbacks.** Svelte 5 idiomatic — the
dialog reads a boolean directly instead of maintaining a parallel state machine.
Minimal wiring, no status enum leaking across component boundaries.

**Array artifact-ref fields fall through to text input.** The enrichment pipeline
injects `format: "artifact-ref"` on array fields too, but multi-file upload per
field is out of scope. The guard `fieldDef.type !== "array"` ensures these
render as plain text inputs.

**No chatId passed to upload.** Artifacts created from the modal are standalone —
not associated with any chat session. The signal payload references them by ID.

**Upload functions extracted, not abstracted.** Moved as-is from
`app-context.svelte.ts` with identical signatures. `handleFileDrop` (chat flow)
now imports from the shared module. No new abstraction layer.

## Out of Scope

- Filtering accepted file types based on schema description keywords
- Multiple files per artifact-ref field (multi-file arrays)
- Reusing previously uploaded artifacts (artifact picker/search)
- Preview of uploaded file contents in the modal
- Server-side changes (existing upload + signal trigger APIs are sufficient)
- Byte-level progress for chunked uploads (reports at ~5MB chunk granularity)

## Test Coverage

**`artifact-ref-input.test.ts`** — 12 tests covering the state machine: idle
rendering, validation errors, upload progress, ready state, onchange callbacks,
cancel/abort, retry, status change callbacks, and component destroy cleanup.
Mocks `validateFile` and `uploadFile` from the shared upload module.

**`run-job-dialog.test.ts`** — 14 tests covering field routing (boolean,
artifact-ref, number, text), upload state tracking via bound props,
formData integration, and array artifact-ref fallback to text input.
