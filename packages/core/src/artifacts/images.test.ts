import { describe, expect, it, vi } from "vitest";
import { resolveImageParts } from "./images.ts";
import type { Artifact } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

/**
 * Creates a minimal file artifact for testing.
 * Only includes fields that resolveImageParts actually uses.
 */
function makeFileArtifact(overrides: {
  id: string;
  mimeType: string;
  originalName?: string;
}): Artifact {
  return {
    id: overrides.id,
    type: "file",
    revision: 1,
    data: {
      type: "file",
      contentRef: "0".repeat(64),
      size: 0,
      mimeType: overrides.mimeType,
      originalName: overrides.originalName ?? "file.bin",
    },
    title: "test",
    summary: "test",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * Creates a mock storage adapter with only readBinaryContents stubbed.
 */
function makeStorage(
  impl: (input: {
    id: string;
    revision?: number;
  }) =>
    | Promise<{ ok: true; data: Uint8Array } | { ok: false; error: string }>
    | ({ ok: true; data: Uint8Array } | { ok: false; error: string }),
): ArtifactStorageAdapter {
  return { readBinaryContents: vi.fn(impl) } as unknown as ArtifactStorageAdapter;
}

describe("resolveImageParts", () => {
  it("produces ImagePart for image artifacts with successful binary read", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const artifact = makeFileArtifact({
      id: "img-1",
      mimeType: "image/png",
      originalName: "photo.png",
    });
    const storage = makeStorage(() => ({ ok: true, data: pngBytes }));

    const parts = await resolveImageParts([artifact], storage);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", image: pngBytes, mediaType: "image/png" });
  });

  it("produces TextPart fallback when binary read fails", async () => {
    const artifact = makeFileArtifact({
      id: "img-2",
      mimeType: "image/jpeg",
      originalName: "broken.jpg",
    });
    const storage = makeStorage(() => ({ ok: false, error: "not found" }));

    const parts = await resolveImageParts([artifact], storage);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "text",
      text: "[Image: broken.jpg — could not be loaded]",
    });
  });

  it("skips non-image artifacts", async () => {
    const textArtifact = makeFileArtifact({
      id: "txt-1",
      mimeType: "text/plain",
      originalName: "readme.txt",
    });
    const imageArtifact = makeFileArtifact({
      id: "img-3",
      mimeType: "image/webp",
      originalName: "icon.webp",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const storage = makeStorage(() => ({ ok: true, data: bytes }));

    const parts = await resolveImageParts([textArtifact, imageArtifact], storage);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/webp" });
  });

  it("returns empty array when no artifacts are images", async () => {
    const artifact = makeFileArtifact({
      id: "csv-1",
      mimeType: "text/csv",
      originalName: "data.csv",
    });
    const storage = makeStorage(() => ({ ok: true, data: new Uint8Array() }));

    const parts = await resolveImageParts([artifact], storage);

    expect(parts).toHaveLength(0);
  });

  it("handles mixed success and failure across multiple images", async () => {
    const good = makeFileArtifact({
      id: "img-ok",
      mimeType: "image/gif",
      originalName: "anim.gif",
    });
    const bad = makeFileArtifact({
      id: "img-fail",
      mimeType: "image/png",
      originalName: "missing.png",
    });
    const bytes = new Uint8Array([0x47, 0x49, 0x46]);

    const storage = makeStorage((input) => {
      if (input.id === "img-ok") return { ok: true, data: bytes };
      return { ok: false, error: "storage error" };
    });

    const parts = await resolveImageParts([good, bad], storage);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "image", image: bytes, mediaType: "image/gif" });
    expect(parts[1]).toMatchObject({
      type: "text",
      text: "[Image: missing.png — could not be loaded]",
    });
  });
});
