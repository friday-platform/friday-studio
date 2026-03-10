# Audio Transcription

**Status:** Shipped (2026-03-09, branch `transcription`)

## Problem Statement

Users have audio files (voice memos, meeting recordings, podcast clips) they want
to work with in Friday. Today there's no way to upload audio or convert it to text.
Users must manually transcribe or use an external tool before bringing content into
the platform.

## Solution

Add audio file upload support to the web UI and a bundled transcription agent that
converts audio to text via Groq's Whisper API. Users attach an audio file, the
conversation agent delegates to the transcription agent, and the transcript is
stored as a reusable text artifact.

## Implementation Decisions

### Upload Pipeline

Audio files follow the same upload flow as images — stored as raw binary, no
server-side conversion at upload time. Changes are additive to existing
infrastructure:

- Audio extensions and MIME types added to `EXTENSION_TO_MIME` and
  `ALLOWED_MIME_TYPES` in `packages/core/src/artifacts/file-upload.ts`
- `MAX_AUDIO_SIZE` constant (25MB) matching Groq Whisper's API limit
- `isAudioMimeType()` helper mirroring the existing `isImageMimeType()`
- Client-side `validateFile()` has audio size check (same pattern as image check)
- Server-side `convertUploadedFile()` stores audio as-is, rejects files exceeding
  `MAX_AUDIO_SIZE` with a 413 error
- `fileTypeHint` in artifact-ref-input component mentions audio
- `FILE_TYPE_NOT_ALLOWED_ERROR` message includes audio formats

### Supported Formats

All formats accepted by Groq Whisper. Both audio and video MIME variants are
allowed for container formats (`.mp4`, `.webm`) because browsers report
`video/*` for files with video tracks, and Whisper extracts the audio track
regardless.

| Extension | MIME Types                  |
|-----------|-----------------------------|
| `.mp3`    | `audio/mpeg`                |
| `.mp4`    | `audio/mp4`, `video/mp4`    |
| `.m4a`    | `audio/x-m4a`              |
| `.wav`    | `audio/wav`                 |
| `.webm`   | `audio/webm`, `video/webm`  |
| `.ogg`    | `audio/ogg`                 |
| `.flac`   | `audio/flac`                |
| `.mpeg`   | `audio/mpeg`                |
| `.mpga`   | `audio/mpeg`                |

### Bundled Transcription Agent

Agent at `packages/bundled-agents/src/transcription/agent.ts`:

- **ID:** `transcribe`
- **Display name:** Transcription
- **Model:** `whisper-large-v3-turbo` via `groq.transcription('whisper-large-v3-turbo')`
- **SDK:** `experimental_transcribe` from `ai` package (AI SDK v5)

**Handler flow:**

1. Emit progress: `"Reading audio file..."`
2. Extract artifact IDs from prompt via UUID regex, validate against artifact
   store, and filter to audio/video MIME types. No LLM call — UUIDs have a
   fixed format and the validation layer handles false positives.
3. For each discovered audio artifact:
   a. Read binary audio via `ArtifactStorage.readBinaryContents({ id })`
   b. Emit progress: `"Transcribing audio..."` (includes filename when multiple)
   c. Call `experimental_transcribe` with the audio `Uint8Array`
   d. If the call throws `AI_NoTranscriptGeneratedError`, record error and continue
   e. Emit progress: `"Saving transcript..."`
   f. Create a text file artifact (`.txt`) with transcript content via
      `ArtifactStorage.create()`. Title format: `"Transcript: {originalFileName}"`
5. Return `ok({ transcripts }, { artifactRefs })`

**Output schema:**

```typescript
z.object({
  transcripts: z.array(z.object({
    fileName: z.string(),
    transcript: z.string().optional(),   // Full text (absent on error)
    error: z.string().optional(),        // Error message if this file failed
  })),
})
```

`language` and `durationInSeconds` were removed from the schema — Groq's Whisper
API doesn't reliably return them.

### Error Handling

- `AI_NoTranscriptGeneratedError` → `"No speech detected in audio file"`
- Groq 429 → `"Transcription service is busy, try again shortly"`
- Groq 5xx / network failure → `"Transcription service unavailable"`
- AbortError re-thrown for cancellation support

### Known Limitations

- **Silent audio hallucination:** Whisper hallucinates short phrases (e.g.
  "Thank you.") from silent audio rather than throwing
  `AI_NoTranscriptGeneratedError`. This is known upstream Whisper behavior, not
  a bug in our error classification.
- **UUID false positives:** Regex-based extraction can match non-artifact UUIDs
  in the prompt. Validation against the artifact store filters these out — failure
  mode is a harmless no-op, not a crash.

## Out of Scope

- Chunked audio transcription (files over 25MB)
- Upload-time auto-transcription
- Speaker diarization
- Live/streaming transcription
- Video content analysis (audio extraction works, visual analysis does not)
- Client-side audio recording (MediaRecorder UI)
- Audio playback in chat (inline `<audio>` player)
- Transcript segments/timestamps
