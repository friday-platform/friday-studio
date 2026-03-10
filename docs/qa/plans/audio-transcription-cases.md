# QA Plan: Audio Transcription

**Context**: docs/plans/2026-03-08-audio-transcription-design.v3.md
**Branch**: transcription
**Date**: 2026-03-09

## Prerequisites

- Daemon running (`deno task atlas daemon start --detached`)
- Web client running (`cd apps/web-client && npm run dev` → localhost:1420)
- Groq API key configured (already in platform environment)
- Test fixtures:
  - A real audio file with speech (mp3/m4a/wav) for transcription cases
  - Generate silent and oversized fixtures with ffmpeg:

```bash
# Silent audio (5 seconds, no speech)
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 5 -q:a 9 /tmp/silent.mp3

# Oversized audio (33MB raw wav, exceeds 25MB limit)
ffmpeg -f lavfi -i "sine=frequency=440:duration=180" -ar 48000 -ac 2 -f wav /tmp/oversized.wav
```

  - Verify: `ls -lh /tmp/silent.mp3 /tmp/oversized.wav` (silent ~20KB,
    oversized ~33MB)

## Cases

### 1. Upload audio via file picker

**Trigger**: Open localhost:1420, start a new chat, click the attachment button,
select the sample mp3 file.
**Expect**: File uploads successfully. Chat input shows the audio file as an
attachment reference (text like `recording.mp3`). No error messages. The file
hint text mentions "audio" as a supported type.
**If broken**: Check browser console for upload errors. Check daemon logs:
`deno task atlas logs --since 30s`. Look at
`apps/atlasd/routes/artifacts.ts` upload endpoint and
`packages/core/src/artifacts/file-upload.ts` MIME validation.

### 2. Upload audio via drag-and-drop

**Trigger**: Open localhost:1420, start a new chat, drag the sample mp3 file
from Finder into the chat input area.
**Expect**: Same as case 1 — file uploads, appears as attachment reference.
**If broken**: Same investigation as case 1. Also check
`apps/web-client/src/lib/components/artifact-ref-input.svelte` for drag
handler issues.

### 3. Reject oversized audio file (client-side)

**Trigger**: In the web client, attempt to upload `/tmp/oversized.wav` via file
picker.
**Expect**: Upload is rejected *before* network request. Error message says
something like "Audio files must be under 25MB." File is not sent to the server.
**If broken**: Check `apps/web-client/src/lib/utils/upload.ts` `validateFile()`
audio size check. Verify `MAX_AUDIO_SIZE` constant in
`packages/core/src/artifacts/file-upload.ts`.

### 4. Reject oversized audio file (server-side)

**Trigger**: Use curl to bypass client validation and POST an oversized audio
file directly:
```bash
curl -X POST http://localhost:8080/api/artifacts/upload \
  -F "file=@/tmp/oversized.wav" \
  -w "\n%{http_code}"
```
**Expect**: Server returns 413 status code. Response body includes an error
message about file size.
**If broken**: Check `apps/atlasd/routes/artifacts.ts` audio size enforcement
(around line 1078). Check `MAX_AUDIO_SIZE` import.

### 5. Reject unsupported file format

**Trigger**: Try to upload a `.exe` or `.zip` file via the web client.
**Expect**: Rejected with error message listing supported formats — message
should now include audio formats alongside CSV, PDF, images, etc.
**If broken**: Check `FILE_TYPE_NOT_ALLOWED_ERROR` in
`packages/core/src/artifacts/file-upload.ts`. Verify `ALLOWED_MIME_TYPES` set.

### 6. Transcribe single audio file

**Trigger**: Upload the sample mp3, then send the message: "Transcribe this"
**Expect**: The transcription agent is invoked (progress messages appear:
"Reading audio file...", "Transcribing audio...", "Saving transcript..."). The
response includes the transcript text. A transcript artifact is created (visible
in the response as a file reference).
**If broken**: Check daemon logs: `deno task atlas logs --since 60s`. Look at
`packages/bundled-agents/src/transcription/agent.ts`. Verify Groq API key with
`deno task atlas logs --level error`. Check
`packages/bundled-agents/src/transcription/discovery.ts` if artifact IDs aren't
being extracted.

### 7. Transcribe via CLI

**Trigger**: Upload an audio file via the web client first (note the chatId from
the URL), then continue the conversation via CLI:
```bash
deno task atlas prompt --chat <chatId> "transcribe the audio file"
```
**Expect**: CLI streams back the transcription result with transcript text.
Transcript artifact is created.
**If broken**: Same as case 6. Also check
`deno task atlas chat <chatId> --human` for full transcript.

### 8. Silent audio — no speech detected

**Trigger**: Upload `/tmp/silent.mp3`, then send: "Transcribe this"
**Expect**: Known Whisper limitation — silent audio may produce hallucinated
short phrases (e.g. "Thank you.") rather than an error. If Whisper throws
`AI_NoTranscriptGeneratedError`, the agent returns a graceful "No speech
detected" message. Otherwise, expect a short phantom transcript.
**If broken**: Check error classification in
`packages/bundled-agents/src/transcription/agent.ts` (the
`classifyTranscriptionError` function). Look for
`AI_NoTranscriptGeneratedError` handling.

### 9. Multiple audio files — batch transcription

**Trigger**: Upload two different audio files in the same chat (or same
message), then send: "Transcribe these files"
**Expect**: Both files are transcribed. Response includes two transcripts. Two
separate transcript artifacts are created.
**If broken**: Check the discovery module
(`packages/bundled-agents/src/transcription/discovery.ts`) — is it finding both
artifact IDs? Check the processing loop in the agent for multi-file handling.

### 10. Format coverage — m4a

**Trigger**: If you have an `.m4a` file (or rename the sample to `.m4a`), upload
and transcribe it.
**Expect**: Upload succeeds, transcription returns valid text.
**If broken**: Check MIME type mapping in `file-upload.ts` for `.m4a` →
`audio/x-m4a`. Check server-side `SPECIFIC_BINARY_MIMES` in
`apps/atlasd/routes/artifacts.ts`.

### 11. Format coverage — mp4 container (video MIME)

**Trigger**: Upload an `.mp4` file (video container with audio track) and
transcribe it.
**Expect**: Upload succeeds despite browser reporting `video/mp4` MIME type.
Transcription returns the audio track's text content.
**If broken**: Verify `video/mp4` is in `ALLOWED_MIME_TYPES`. Check
`isAudioMimeType()` accepts `video/mp4` and `video/webm` variants.

### 12. Agent chaining — transcribe and summarize

**Trigger**: Upload an audio file, then send: "Transcribe this and summarize it"
**Expect**: The transcription agent runs first (progress messages visible), then
the conversation agent (or another agent) produces a summary of the transcript.
Both the full transcript artifact and the summary appear in the response.
**If broken**: Check planner routing — is it delegating to transcription first?
Check whether the transcript artifact ref is visible in the conversation context
for the follow-up summarization step. Look at
`deno task atlas chat <chatId> --human` for the full exchange.

### 13. Transcript artifact is reusable

**Trigger**: After case 6 or 7 completes, send a follow-up message in the same
chat: "What language was the transcript in?" or "Can you bullet-point the key
topics from the transcript?"
**Expect**: The agent references the previously created transcript artifact and
works with its contents. No re-transcription occurs.
**If broken**: Check message windowing — is the transcript artifact ref visible
in the conversation context? Check `deno task atlas chat <chatId> --human`.

### 14. Transcript artifact visible in library

**Trigger**: After a successful transcription, navigate to the Library page
(localhost:1420/library).
**Expect**: The transcript artifact appears in the library with title format
"Transcript: {originalFileName}". Clicking it shows the transcript text.
**If broken**: Check artifact creation in the agent — verify `type: "file"` and
title format. Check `GET /api/library` response.

### 15. Upload progress indicator (UI)

**Trigger**: Upload a larger audio file (several MB) via the web client and
watch the UI during upload.
**Expect**: Some form of progress indication during upload (progress bar,
spinner, or percentage). The UI doesn't freeze or appear broken during upload.
**If broken**: Check
`apps/web-client/src/lib/components/artifact-ref-input.svelte` for upload state
handling.

## Smoke Candidates

- **Case 6** (single file transcription) — core happy path, exercises the full
  pipeline from upload to transcript artifact
- **Case 3** (oversized rejection) — validates the size guard, quick to run
- **Case 8** (silent audio) — validates error handling, catches regressions in
  Whisper error classification
