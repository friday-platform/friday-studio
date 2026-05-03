/**
 * Tests for discoverAudioFiles — exercises UUID regex extraction and artifact
 * validation: audio/video filtering, non-existent IDs, non-audio types,
 * getManyLatest failures, and deduplication.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { discoverAudioFiles } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const getManyLatestMock = vi.hoisted(() => vi.fn());

vi.mock("@atlas/core/artifacts/server", () => ({
  ArtifactStorage: { getManyLatest: getManyLatestMock },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileArtifact(id: string, mimeType: string, originalName = "file.mp3") {
  return {
    id,
    type: "file",
    revision: 1,
    data: { type: "file", contentRef: "0".repeat(64), size: 0, mimeType, originalName },
    title: originalName,
    summary: "test",
    createdAt: "2026-03-09T00:00:00Z",
  };
}

function makeDatabaseArtifact(id: string) {
  // The artifact `type` union narrowed to "file" only after the
  // 2026-05-02 redesign; this fixture intentionally uses a
  // non-"file" type to verify the discovery filter rejects non-audio
  // artifacts. Cast to the test mock's expected shape.
  return {
    id,
    type: "database",
    revision: 1,
    data: { type: "database" },
    title: "test.db",
    summary: "test database",
    createdAt: "2026-03-09T00:00:00Z",
  };
}

afterEach(() => {
  getManyLatestMock.mockReset();
});

// ---------------------------------------------------------------------------
// UUID extraction
// ---------------------------------------------------------------------------

describe("discoverAudioFiles", () => {
  test("no UUIDs in prompt returns empty without calling storage", async () => {
    const result = await discoverAudioFiles("Transcribe this recording please");

    expect(getManyLatestMock).not.toHaveBeenCalled();
    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });

  test("extracts UUID from attached file format", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/mpeg", "memo.mp3");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverAudioFiles(
      `[Attached files: memo.mp3 (artifact:${id})]\n\nTranscribe this`,
    );

    expect(getManyLatestMock).toHaveBeenCalledWith({ ids: [id] });
    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts UUID from signal data JSON", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/wav", "recording.wav");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `## Signal Data\n{"audio_file": "${id}"}\n\nTranscribe the audio`;
    const result = await discoverAudioFiles(prompt);

    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts UUID from workspace resources section", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/ogg", "podcast.ogg");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `## Workspace Resources\n\n### Files\n- podcast.ogg (artifact:${id}): Uploaded file`;
    const result = await discoverAudioFiles(prompt);

    expect(result.artifactIds).toEqual([id]);
  });

  test("deduplicates repeated UUIDs", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/mpeg", "memo.mp3");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `artifact:${id} and again artifact:${id}`;
    const result = await discoverAudioFiles(prompt);

    expect(getManyLatestMock).toHaveBeenCalledWith({ ids: [id] });
    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts multiple distinct UUIDs", async () => {
    const id1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const id2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const art1 = makeFileArtifact(id1, "audio/mpeg", "file1.mp3");
    const art2 = makeFileArtifact(id2, "audio/wav", "file2.wav");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [art1, art2] });

    const prompt = `${id1} and ${id2}`;
    const result = await discoverAudioFiles(prompt);

    expect(result.artifactIds).toEqual([id1, id2]);
    expect(result.artifacts.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Artifact filtering
  // ---------------------------------------------------------------------------

  test("valid audio artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/mpeg", "memo.mp3");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverAudioFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
    expect(result.artifacts.get(id)).toEqual(artifact);
  });

  test("video artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "video/mp4", "recording.mp4");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverAudioFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
  });

  test("non-audio file artifacts are rejected", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "text/csv", "data.csv");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverAudioFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });

  test("non-file artifact types are rejected", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeDatabaseArtifact(id);
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverAudioFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([]);
  });

  test("non-existent artifact IDs are silently dropped", async () => {
    getManyLatestMock.mockResolvedValue({ ok: true, data: [] });

    const result = await discoverAudioFiles("artifact:00000000-0000-0000-0000-000000000000");

    expect(result.artifactIds).toEqual([]);
  });

  test("mixed valid and invalid IDs returns only valid audio", async () => {
    const audioId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const csvId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const ghostId = "c3d4e5f6-a7b8-9012-cdef-123456789012";
    const audio = makeFileArtifact(audioId, "audio/mpeg", "memo.mp3");
    const csv = makeFileArtifact(csvId, "text/csv", "data.csv");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [audio, csv] });

    const result = await discoverAudioFiles(`${audioId} ${csvId} ${ghostId}`);

    expect(result.artifactIds).toEqual([audioId]);
    expect(result.artifacts.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("getManyLatest failure returns empty", async () => {
    getManyLatestMock.mockResolvedValue({ ok: false, error: "network timeout" });

    const result = await discoverAudioFiles("artifact:a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });
});
