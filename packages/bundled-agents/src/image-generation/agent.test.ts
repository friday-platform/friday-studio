/**
 * Tests for imageGenerationAgent — verifies generate mode (text-to-image)
 * and edit mode (image-to-image) via mocked generateImage(), covering happy
 * paths, error handling, progress emission, abort propagation, artifact
 * creation failure, and MIME type handling.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { imageGenerationAgent } from "./agent.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const generateImageMock = vi.hoisted(() => vi.fn());
const createArtifactMock = vi.hoisted(() => vi.fn());
const readBinaryContentsMock = vi.hoisted(() => vi.fn());
const discoverImageFilesMock = vi.hoisted(() => vi.fn());
const smallLLMMock = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@atlas/core/artifacts/server", () => ({
  ArtifactStorage: { create: createArtifactMock, readBinaryContents: readBinaryContentsMock },
}));

vi.mock("ai", () => ({ generateImage: generateImageMock }));

vi.mock("./discovery.ts", () => ({ discoverImageFiles: discoverImageFilesMock }));

vi.mock("@atlas/llm", () => ({
  registry: { imageModel: () => "gemini-mock" },
  smallLLM: smallLLMMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const mockStream = { emit: vi.fn() };

function makeContext(config?: Record<string, unknown>) {
  return {
    session: { sessionId: "sess-1", workspaceId: "ws-1", streamId: "chat-1" },
    logger: mockLogger,
    stream: mockStream,
    tools: {},
    env: {},
    config,
    abortSignal: undefined,
  } as never;
}

function makeGenerateImageResult(
  images: Array<{ uint8Array: Uint8Array; mediaType: string; base64: string }>,
) {
  return { image: images[0], images, warnings: [], responses: [] };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeImageFile(mediaType = "image/png") {
  const bytes =
    mediaType === "image/jpeg"
      ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      : new Uint8Array([137, 80, 78, 71]);
  return { uint8Array: bytes, mediaType, base64: uint8ToBase64(bytes) };
}

function makeImageArtifact(id: string, mimeType = "image/png") {
  return {
    id,
    type: "file",
    revision: 1,
    data: {
      type: "file",
      contentRef: "0".repeat(64),
      size: 0,
      mimeType,
      originalName: `${id}.png`,
    },
    title: `${id}.png`,
    summary: "Image file",
    createdAt: "2026-03-23T00:00:00Z",
  };
}

/** Builds the discovery mock return value with a pre-validated artifacts Map. */
function makeDiscoveryResult(entries: Array<{ id: string; mimeType?: string }>) {
  const artifactIds = entries.map((e) => e.id);
  const artifacts = new Map(entries.map((e) => [e.id, makeImageArtifact(e.id, e.mimeType)]));
  return { artifactIds, artifacts };
}

/** Standard mock setup for the artifact save path. */
function setupSaveMocks() {
  createArtifactMock.mockResolvedValue({
    ok: true,
    data: { id: "artifact-out-1", type: "file", summary: "Image output" },
  });
}

afterEach(() => {
  generateImageMock.mockReset();
  createArtifactMock.mockReset();
  readBinaryContentsMock.mockReset();
  discoverImageFilesMock.mockReset();
  smallLLMMock.mockReset();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("imageGenerationAgent", () => {
  // Default: no image artifacts found → generate mode, smallLLM returns a title
  beforeEach(() => {
    discoverImageFilesMock.mockResolvedValue({ artifactIds: [], artifacts: new Map() });
    smallLLMMock.mockResolvedValue("Sunset over mountains");
  });

  test("generates image, creates artifact, and returns ok with artifactRef", async () => {
    const imageFile = makeImageFile();
    generateImageMock.mockResolvedValue(makeGenerateImageResult([imageFile]));
    createArtifactMock.mockResolvedValue({
      ok: true,
      data: { id: "artifact-out-1", type: "file", summary: "A beautiful sunset image" },
    });

    const result = await imageGenerationAgent.execute(
      "Generate an image of a sunset over mountains",
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    expect(result.data).toMatchObject({
      description: "Generate an image of a sunset over mountains",
      mode: "generate",
    });
    expect(result.artifactRefs).toEqual([
      { id: "artifact-out-1", type: "file", summary: "A beautiful sunset image" },
    ]);
    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        chatId: "chat-1",
        title: expect.stringContaining("Generated Image:"),
        data: expect.objectContaining({
          type: "file",
          mimeType: "image/png",
          originalName: "generated-image.png",
        }),
      }),
    );
  });

  test("returns error when model produces no image", async () => {
    generateImageMock.mockResolvedValue(makeGenerateImageResult([]));

    const result = await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Model did not generate an image");
  });

  test("re-throws AbortError for cancellation", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    generateImageMock.mockRejectedValue(abortError);

    await expect(imageGenerationAgent.execute("Generate an image", makeContext())).rejects.toThrow(
      "The operation was aborted",
    );
  });

  test("returns error when artifact creation fails", async () => {
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    createArtifactMock.mockResolvedValue({ ok: false, error: "Storage full" });

    const result = await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error.reason).toContain("Failed to save generated image");
  });

  test("passes 1024x1024 size to generateImage", async () => {
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(generateImageMock).toHaveBeenCalledWith(expect.objectContaining({ size: "1024x1024" }));
  });

  test("uses JPEG extension when model returns image/jpeg", async () => {
    const jpegFile = makeImageFile("image/jpeg");
    generateImageMock.mockResolvedValue(makeGenerateImageResult([jpegFile]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: "image/jpeg",
          originalName: "generated-image.jpg",
        }),
      }),
    );
  });

  test("uses PNG extension when model returns image/png", async () => {
    const pngFile = makeImageFile("image/png");
    generateImageMock.mockResolvedValue(makeGenerateImageResult([pngFile]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: "image/png",
          originalName: "generated-image.png",
        }),
      }),
    );
  });

  test("uses smallLLM-generated title for artifact", async () => {
    smallLLMMock.mockResolvedValue("Vibrant sunset over mountain range");
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate a sunset", makeContext());

    expect(smallLLMMock).toHaveBeenCalled();
    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Generated Image: Vibrant sunset over mountain range",
        summary: "Generate a sunset",
      }),
    );
  });

  test("falls back to image-id title when smallLLM fails", async () => {
    smallLLMMock.mockRejectedValue(new Error("LLM unavailable"));
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate a sunset", makeContext());

    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(
          /^Generated Image: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      }),
    );
  });

  test("falls back to image-id title when smallLLM returns empty", async () => {
    smallLLMMock.mockResolvedValue("  ");
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate a sunset", makeContext());

    expect(createArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(
          /^Generated Image: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      }),
    );
  });

  test("generate mode emits 'Generating image...' progress", async () => {
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    expect(mockStream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-tool-progress",
        data: expect.objectContaining({ content: "Generating image..." }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Edit mode — image-to-image via source artifact loading
  // -------------------------------------------------------------------------

  describe("edit mode", () => {
    const sourceBytes = new Uint8Array([137, 80, 78, 71]);

    test("loads source image, calls generateImage with image prompt, and returns ok", async () => {
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-art-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: true, data: sourceBytes });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute(
        "Make the sky more dramatic src-art-1",
        makeContext(),
      );

      expect(result.ok).toBe(true);
      expect.assert(result.ok === true);
      expect(result.data).toMatchObject({ mode: "edit", sourceArtifactIds: ["src-art-1"] });
      expect(readBinaryContentsMock).toHaveBeenCalledWith({ id: "src-art-1" });
      expect(generateImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: { images: [sourceBytes], text: "Make the sky more dramatic src-art-1" },
        }),
      );
    });

    test("passes multiple source images when several artifacts discovered", async () => {
      const bytes2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      discoverImageFilesMock.mockResolvedValue(
        makeDiscoveryResult([{ id: "img-1" }, { id: "img-2" }]),
      );
      readBinaryContentsMock
        .mockResolvedValueOnce({ ok: true, data: sourceBytes })
        .mockResolvedValueOnce({ ok: true, data: bytes2 });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute(
        "Combine these images img-1 img-2",
        makeContext(),
      );

      expect(result.ok).toBe(true);
      expect.assert(result.ok === true);
      expect(result.data.sourceArtifactIds).toEqual(["img-1", "img-2"]);
      expect(generateImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: { images: [sourceBytes, bytes2], text: "Combine these images img-1 img-2" },
        }),
      );
    });

    test("skips unreadable source images and proceeds with remaining", async () => {
      discoverImageFilesMock.mockResolvedValue(
        makeDiscoveryResult([{ id: "good-1" }, { id: "bad-1" }]),
      );
      readBinaryContentsMock
        .mockResolvedValueOnce({ ok: true, data: sourceBytes })
        .mockResolvedValueOnce({ ok: false, error: "File not found" });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute("Edit good-1 bad-1", makeContext());

      expect(result.ok).toBe(true);
      expect(generateImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: { images: [sourceBytes], text: "Edit good-1 bad-1" } }),
      );
    });

    test("returns error when all source images fail to load", async () => {
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "bad-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: false, error: "File not found" });

      const result = await imageGenerationAgent.execute("Edit bad-1", makeContext());

      expect(result.ok).toBe(false);
      expect.assert(result.ok === false);
      expect(result.error.reason).toContain("Could not load any source images");
      expect(generateImageMock).not.toHaveBeenCalled();
    });

    test("emits Loading → Editing → Saving progress sequence", async () => {
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: true, data: sourceBytes });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      await imageGenerationAgent.execute("Edit src-1", makeContext());

      const progressCalls = mockStream.emit.mock.calls
        .filter((args) => args[0]?.type === "data-tool-progress")
        .map((args) => args[0].data.content);

      expect(progressCalls).toEqual([
        "Loading source images...",
        "Editing image...",
        "Saving image...",
      ]);
    });

    test("uses 'Edited Image' title prefix for edit mode artifacts", async () => {
      smallLLMMock.mockResolvedValue("Brightened landscape photo");
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: true, data: sourceBytes });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      await imageGenerationAgent.execute("Make it brighter src-1", makeContext());

      expect(createArtifactMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Edited Image: Brightened landscape photo",
          data: expect.objectContaining({ originalName: "edited-image.png" }),
        }),
      );
    });

    test("returns edit-specific error message when generateImage fails", async () => {
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: true, data: sourceBytes });
      generateImageMock.mockResolvedValue(null);

      const result = await imageGenerationAgent.execute("Edit src-1", makeContext());

      expect(result.ok).toBe(false);
      expect.assert(result.ok === false);
      expect(result.error.reason).toContain("Image editing failed");
    });
  });
});
