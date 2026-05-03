/**
 * Tests for transcriptionAgent — verifies transcription of audio artifacts
 * via mocked Groq Whisper (experimental_transcribe), covering happy path,
 * multi-file, partial failure, empty transcript, and API errors.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { transcriptionAgent } from "./agent.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const readBinaryContentsMock = vi.hoisted(() => vi.fn());
const createArtifactMock = vi.hoisted(() => vi.fn());
const transcribeMock = vi.hoisted(() => vi.fn());
const discoverAudioFilesMock = vi.hoisted(() => vi.fn());
const getWorkspaceFilesDirMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const unlinkMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@atlas/core/artifacts/server", () => ({
  ArtifactStorage: { readBinaryContents: readBinaryContentsMock, create: createArtifactMock },
}));

vi.mock("ai", () => ({ experimental_transcribe: transcribeMock }));

vi.mock("./discovery.ts", () => ({ discoverAudioFiles: discoverAudioFilesMock }));

vi.mock("@atlas/utils/paths.server", () => ({ getWorkspaceFilesDir: getWorkspaceFilesDirMock }));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  unlink: unlinkMock,
  writeFile: writeFileMock,
}));

vi.mock("@atlas/llm", () => ({ registry: { transcriptionModel: () => "groq-whisper-mock" } }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const mockStream = { emit: vi.fn() };

function makeContext() {
  return {
    session: { sessionId: "sess-1", workspaceId: "ws-1", streamId: "chat-1" },
    logger: mockLogger,
    stream: mockStream,
    tools: {},
    env: {},
    abortSignal: undefined,
  } as never;
}

function makeAudioArtifact(id: string, originalName: string) {
  return {
    id,
    type: "file",
    revision: 1,
    data: {
      type: "file",
      contentRef: "0".repeat(64),
      size: 0,
      mimeType: "audio/mpeg",
      originalName,
    },
    title: originalName,
    summary: "Audio file",
    createdAt: "2026-03-09T00:00:00Z",
  };
}

/** Builds the discovery mock return value with a pre-validated artifacts Map. */
function makeDiscoveryResult(entries: Array<{ id: string; originalName: string }>) {
  const artifactIds = entries.map((e) => e.id);
  const artifacts = new Map(entries.map((e) => [e.id, makeAudioArtifact(e.id, e.originalName)]));
  return { artifactIds, artifacts };
}

afterEach(() => {
  readBinaryContentsMock.mockReset();
  createArtifactMock.mockReset();
  transcribeMock.mockReset();
  discoverAudioFilesMock.mockReset();
  getWorkspaceFilesDirMock.mockReset();
  mkdirMock.mockReset();
  unlinkMock.mockReset();
  writeFileMock.mockReset();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transcriptionAgent", () => {
  test("transcribes a single audio file and returns transcript with artifact ref", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1, 2, 3]) });
    transcribeMock.mockResolvedValue({
      text: "Hello world",
      language: "en",
      durationInSeconds: 12.5,
    });
    getWorkspaceFilesDirMock.mockReturnValue("/tmp/ws-files");
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    createArtifactMock.mockResolvedValue({
      ok: true,
      data: { id: "artifact-out-1", type: "file", summary: "Hello world" },
    });

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    expect(result.data.transcripts).toHaveLength(1);
    expect(result.data.transcripts[0]).toMatchObject({
      status: "ok",
      fileName: "memo.mp3",
      transcript: "Hello world",
    });
    expect(result.artifactRefs).toEqual([
      { id: "artifact-out-1", type: "file", summary: "Hello world" },
    ]);
    expect(writeFileMock).toHaveBeenCalledWith(expect.any(String), "Hello world", "utf-8");
    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        chatId: "chat-1",
        title: "Transcript: memo.mp3",
      }),
    );
  });

  test("transcribes multiple audio files and returns all transcripts with artifact refs", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([
        { id: "art-1", originalName: "part1.mp3" },
        { id: "art-2", originalName: "part2.wav" },
      ]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    transcribeMock
      .mockResolvedValueOnce({ text: "First part", language: "en", durationInSeconds: 10 })
      .mockResolvedValueOnce({ text: "Second part", language: "fr", durationInSeconds: 20 });
    getWorkspaceFilesDirMock.mockReturnValue("/tmp/ws-files");
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    createArtifactMock
      .mockResolvedValueOnce({
        ok: true,
        data: { id: "out-1", type: "file", summary: "First part" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { id: "out-2", type: "file", summary: "Second part" },
      });

    const result = await transcriptionAgent.execute("transcribe these", makeContext());

    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    expect(result.data.transcripts).toHaveLength(2);
    expect(result.data.transcripts[0]).toMatchObject({
      status: "ok",
      fileName: "part1.mp3",
      transcript: "First part",
    });
    expect(result.data.transcripts[1]).toMatchObject({
      status: "ok",
      fileName: "part2.wav",
      transcript: "Second part",
    });
    expect(result.artifactRefs).toHaveLength(2);
  });

  test("returns error message when no speech is detected", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "silence.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    const noSpeechError = new Error("No transcript generated");
    noSpeechError.name = "AI_NoTranscriptGeneratedError";
    transcribeMock.mockRejectedValue(noSpeechError);

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    // All transcriptions failed → err()
    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("No speech detected in audio file");
  });

  test("returns mixed results when one file succeeds and another has no speech", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([
        { id: "art-1", originalName: "speech.mp3" },
        { id: "art-2", originalName: "silence.mp3" },
      ]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    const noSpeechError = new Error("No transcript generated");
    noSpeechError.name = "AI_NoTranscriptGeneratedError";
    transcribeMock
      .mockResolvedValueOnce({ text: "Good audio", language: "en", durationInSeconds: 5 })
      .mockRejectedValueOnce(noSpeechError);
    getWorkspaceFilesDirMock.mockReturnValue("/tmp/ws-files");
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    createArtifactMock.mockResolvedValue({
      ok: true,
      data: { id: "out-1", type: "file", summary: "Good audio" },
    });

    const result = await transcriptionAgent.execute("transcribe these", makeContext());

    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    expect(result.data.transcripts).toHaveLength(2);
    expect(result.data.transcripts[0]).toMatchObject({
      status: "ok",
      fileName: "speech.mp3",
      transcript: "Good audio",
    });
    const failedEntry = result.data.transcripts[1];
    expect.assert(failedEntry !== undefined);
    expect(failedEntry).toMatchObject({
      status: "error",
      fileName: "silence.mp3",
      error: "No speech detected in audio file",
    });
  });

  test("returns error message when Groq API fails", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    transcribeMock.mockRejectedValue(new Error("Connection refused"));

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Connection refused");
  });

  test("returns error when no audio artifacts found", async () => {
    discoverAudioFilesMock.mockResolvedValue({ artifactIds: [], artifacts: new Map() });

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("No audio file artifacts found");
  });

  test("returns error when discovery fails with non-abort error", async () => {
    discoverAudioFilesMock.mockRejectedValue(new Error("Database connection lost"));

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Failed to identify audio files");
  });

  test("re-throws AbortError from discovery for cancellation", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    discoverAudioFilesMock.mockRejectedValue(abortError);

    await expect(transcriptionAgent.execute("transcribe this", makeContext())).rejects.toThrow(
      "The operation was aborted",
    );
  });

  test("re-throws AbortError from transcription for cancellation", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    const abortError = new DOMException("The operation was aborted", "AbortError");
    transcribeMock.mockRejectedValue(abortError);

    await expect(transcriptionAgent.execute("transcribe this", makeContext())).rejects.toThrow(
      "The operation was aborted",
    );
  });

  test("returns user-friendly message on Groq 429 rate limit", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    const { APICallError } = await import("@ai-sdk/provider");
    transcribeMock.mockRejectedValue(
      new APICallError({
        message: "Rate limit exceeded",
        url: "https://api.groq.com/transcribe",
        requestBodyValues: {},
        statusCode: 429,
      }),
    );

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Transcription service is busy, try again shortly");
  });

  test("returns user-friendly message on Groq 5xx server error", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    const { APICallError } = await import("@ai-sdk/provider");
    transcribeMock.mockRejectedValue(
      new APICallError({
        message: "Internal server error",
        url: "https://api.groq.com/transcribe",
        requestBodyValues: {},
        statusCode: 500,
      }),
    );

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Transcription service unavailable");
  });

  test("records error when readBinaryContents fails", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "missing.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: false, error: "File not found" });

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Failed to read audio file");
  });

  test("cleans up and records error when artifact creation fails", async () => {
    discoverAudioFilesMock.mockResolvedValue(
      makeDiscoveryResult([{ id: "art-1", originalName: "memo.mp3" }]),
    );
    readBinaryContentsMock.mockResolvedValue({ ok: true, data: new Uint8Array([1]) });
    transcribeMock.mockResolvedValue({ text: "Hello world" });
    getWorkspaceFilesDirMock.mockReturnValue("/tmp/ws-files");
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    createArtifactMock.mockResolvedValue({ ok: false, error: "Storage full" });
    unlinkMock.mockResolvedValue(undefined);

    const result = await transcriptionAgent.execute("transcribe this", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Failed to save transcript");
    expect(unlinkMock).toHaveBeenCalled();
  });
});
