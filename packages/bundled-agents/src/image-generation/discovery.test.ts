/**
 * Tests for discoverImageFiles — exercises UUID regex extraction and artifact
 * validation: image MIME filtering, non-existent IDs, non-image types,
 * getManyLatest failures, and deduplication.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { discoverImageFiles } from "./discovery.ts";

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

function makeFileArtifact(id: string, mimeType: string, originalName = "image.png") {
  return {
    id,
    type: "file",
    revision: 1,
    data: { type: "file", contentRef: "0".repeat(64), size: 0, mimeType, originalName },
    title: originalName,
    summary: "test",
    createdAt: "2026-03-23T00:00:00Z",
  };
}

function makeDatabaseArtifact(id: string) {
  return {
    id,
    type: "database",
    revision: 1,
    data: { type: "database" },
    title: "test.db",
    summary: "test database",
    createdAt: "2026-03-23T00:00:00Z",
  };
}

afterEach(() => {
  getManyLatestMock.mockReset();
});

// ---------------------------------------------------------------------------
// UUID extraction
// ---------------------------------------------------------------------------

describe("discoverImageFiles", () => {
  test("no UUIDs in prompt returns empty without calling storage", async () => {
    const result = await discoverImageFiles("Generate an image of a sunset");

    expect(getManyLatestMock).not.toHaveBeenCalled();
    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });

  test("extracts UUID from attached file format", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/png", "photo.png");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(
      `[Attached files: photo.png (artifact:${id})]\n\nMake the sky more dramatic`,
    );

    expect(getManyLatestMock).toHaveBeenCalledWith({ ids: [id] });
    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts UUID from signal data JSON", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/jpeg", "photo.jpg");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `## Signal Data\n{"image_file": "${id}"}\n\nEdit this image`;
    const result = await discoverImageFiles(prompt);

    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts UUID from workspace resources section", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/webp", "banner.webp");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `## Workspace Resources\n\n### Files\n- banner.webp (artifact:${id}): Uploaded file`;
    const result = await discoverImageFiles(prompt);

    expect(result.artifactIds).toEqual([id]);
  });

  test("deduplicates repeated UUIDs", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/png", "logo.png");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const prompt = `artifact:${id} and again artifact:${id}`;
    const result = await discoverImageFiles(prompt);

    expect(getManyLatestMock).toHaveBeenCalledWith({ ids: [id] });
    expect(result.artifactIds).toEqual([id]);
  });

  test("extracts multiple distinct UUIDs", async () => {
    const id1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const id2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const art1 = makeFileArtifact(id1, "image/png", "file1.png");
    const art2 = makeFileArtifact(id2, "image/jpeg", "file2.jpg");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [art1, art2] });

    const prompt = `${id1} and ${id2}`;
    const result = await discoverImageFiles(prompt);

    expect(result.artifactIds).toEqual([id1, id2]);
    expect(result.artifacts.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Artifact filtering
  // ---------------------------------------------------------------------------

  test("image/png artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/png", "photo.png");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
    expect(result.artifacts.get(id)).toEqual(artifact);
  });

  test("image/jpeg artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/jpeg", "photo.jpg");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
  });

  test("image/webp artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/webp", "photo.webp");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
  });

  test("image/gif artifacts pass through", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "image/gif", "animation.gif");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([id]);
  });

  test("non-image file artifacts are rejected", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeFileArtifact(id, "audio/mpeg", "song.mp3");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });

  test("non-file artifact types are rejected", async () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const artifact = makeDatabaseArtifact(id);
    getManyLatestMock.mockResolvedValue({ ok: true, data: [artifact] });

    const result = await discoverImageFiles(`artifact:${id}`);

    expect(result.artifactIds).toEqual([]);
  });

  test("non-existent artifact IDs are silently dropped", async () => {
    getManyLatestMock.mockResolvedValue({ ok: true, data: [] });

    const result = await discoverImageFiles("artifact:00000000-0000-0000-0000-000000000000");

    expect(result.artifactIds).toEqual([]);
  });

  test("mixed valid and invalid IDs returns only valid images", async () => {
    const imageId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const audioId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const ghostId = "c3d4e5f6-a7b8-9012-cdef-123456789012";
    const image = makeFileArtifact(imageId, "image/png", "photo.png");
    const audio = makeFileArtifact(audioId, "audio/mpeg", "song.mp3");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [image, audio] });

    const result = await discoverImageFiles(`${imageId} ${audioId} ${ghostId}`);

    expect(result.artifactIds).toEqual([imageId]);
    expect(result.artifacts.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("getManyLatest failure returns empty", async () => {
    getManyLatestMock.mockResolvedValue({ ok: false, error: "network timeout" });

    const result = await discoverImageFiles("artifact:a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    expect(result.artifactIds).toEqual([]);
    expect(result.artifacts.size).toBe(0);
  });
});
