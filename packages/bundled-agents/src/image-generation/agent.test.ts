/**
 * Tests for imageGenerationAgent — verifies generate mode (text-to-image)
 * and edit mode (image-to-image) via mocked generateImage(), covering happy
 * paths, error handling, progress emission, abort propagation, artifact
 * creation failure, and MIME type handling.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageModelV3 } from "@ai-sdk/provider";
import { listImageEntries } from "@atlas/llm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
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

vi.mock("@atlas/llm", async () => {
  // Overlay lookups (`lookupImageEntry`, `listImageEntries`) are pure data
  // reads — pass them through so capability and matrix tests exercise the
  // actual overlay entries. Only `smallLLM` is mocked.
  const actual = await vi.importActual<typeof import("@atlas/llm")>("@atlas/llm");
  return { ...actual, smallLLM: smallLLMMock };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const mockStream = { emit: vi.fn() };

/**
 * Build a stub `ImageModelV3` carrying SDK-shaped `provider` / `modelId`
 * strings. These mirror what real providers return — e.g. Google's SDK reports
 * `provider: "google.generative-ai"`, `modelId: "gemini-2.5-flash-image"`,
 * neither of which match the capability overlay's `provider:model` key. By
 * keeping the stub's shape SDK-accurate (rather than stuffing the overlay key
 * into `modelId`), tests prove the agent looks up the overlay via the resolved
 * `key` and not via `model.modelId` — a regression to the latter would miss
 * every overlay entry and fail the test.
 */
function makeStubImageModel(provider: string, modelId: string): ImageModelV3 {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    maxImagesPerCall: 1,
    doGenerate: () => Promise.reject(new Error("stub ImageModelV3 invoked")),
  };
}

// SDK-shaped defaults: provider is the transport string, modelId is the bare id.
// Neither matches an overlay key on its own — capability lookup must go through
// the resolved `key` returned by `getImageResolved()`.
const stubImageModel = makeStubImageModel("google.generative-ai", "gemini-2.5-flash-image");

const stubPlatformModels = {
  get: vi.fn(),
  getImageResolved: vi.fn(() => ({
    key: "google:gemini-2.5-flash-image",
    model: stubImageModel,
  })),
};

/**
 * Swap the current image model + overlay key for one test. The pair is
 * returned atomically from `getImageResolved()`, so this just queues a
 * one-shot return value. The model is built with the bare id half of the
 * overlay key (post-colon) on a generic stub provider — same SDK shape as
 * production.
 */
function useImageModel(overlayKey: string): void {
  const [provider, modelId] = overlayKey.split(":");
  if (!provider || !modelId) {
    throw new Error(`useImageModel: malformed overlay key "${overlayKey}"`);
  }
  stubPlatformModels.getImageResolved.mockReturnValueOnce({
    key: overlayKey,
    model: makeStubImageModel(`stub.${provider}`, modelId),
  });
}

function makeContext(config?: Record<string, unknown>) {
  return {
    session: { sessionId: "sess-1", workspaceId: "ws-1", streamId: "chat-1" },
    logger: mockLogger,
    stream: mockStream,
    tools: {},
    env: {},
    config,
    abortSignal: undefined,
    platformModels: stubPlatformModels,
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

  test("dispatches aspectRatio param (and no size) for aspectRatio-axis model", async () => {
    // Default stub is google:gemini-2.5-flash-image
    // → { controlAxis: "aspectRatio", aspectRatio: "1:1" }
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    const call = generateImageMock.mock.calls[0]?.[0];
    expect(call.aspectRatio).toBe("1:1");
    expect(call.size).toBeUndefined();
  });

  test("dispatches size param (and no aspectRatio) for size-axis model", async () => {
    // openai:dall-e-3 → { controlAxis: "size", size: "1024x1024" }
    useImageModel("openai:dall-e-3");
    generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
    setupSaveMocks();

    await imageGenerationAgent.execute("Generate an image", makeContext());

    const call = generateImageMock.mock.calls[0]?.[0];
    expect(call.size).toBe("1024x1024");
    expect(call.aspectRatio).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Capability check — edit-mode prompt against a gen-only overlay entry
  // -------------------------------------------------------------------------

  describe("capability check", () => {
    test("returns err with displayName when edit requested on a gen-only model", async () => {
      useImageModel("openai:dall-e-3");
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-1" }]));

      const result = await imageGenerationAgent.execute(
        "Make the sky dramatic src-1",
        makeContext(),
      );

      expect(result.ok).toBe(false);
      expect.assert(result.ok === false);
      expect(result.error.reason).toContain("DALL·E 3");
      expect(result.error.reason).toContain("supports generation only");
      expect(result.error.reason).toContain("Settings → Image");
      expect(generateImageMock).not.toHaveBeenCalled();
    });

    test("proceeds to generateImage in edit mode on an edit-capable model", async () => {
      // Default stub is google:gemini-2.5-flash-image (edit-capable).
      const sourceBytes = new Uint8Array([137, 80, 78, 71]);
      discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-1" }]));
      readBinaryContentsMock.mockResolvedValue({ ok: true, data: sourceBytes });
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute("Edit src-1", makeContext());

      expect(result.ok).toBe(true);
      expect(generateImageMock).toHaveBeenCalled();
    });

    test("proceeds normally in generation mode on a gen-only model", async () => {
      useImageModel("openai:dall-e-3");
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute("Generate a sunset", makeContext());

      expect(result.ok).toBe(true);
      expect(generateImageMock).toHaveBeenCalled();
    });

    // Regression guard for the QA-found bug where the agent looked up the
    // overlay via `model.modelId` (bare id like "gemini-2.5-flash-image"),
    // which never matches the overlay's `provider:model` keys. The default
    // stub's SDK-shaped model has provider "google.generative-ai" and modelId
    // "gemini-2.5-flash-image" — neither is an overlay key. If the agent
    // regresses to either lookup, it'll hit the null branch and `err()` with
    // "unknown to Friday's capability overlay" instead of generating.
    test("uses resolved overlay key — not model.modelId — for capability lookup", async () => {
      generateImageMock.mockResolvedValue(makeGenerateImageResult([makeImageFile()]));
      setupSaveMocks();

      const result = await imageGenerationAgent.execute("Generate a cat", makeContext());

      expect(result.ok).toBe(true);
      expect(stubPlatformModels.getImageResolved).toHaveBeenCalled();
      expect(generateImageMock).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (model × transport) matrix — fixture-driven dispatch + capability checks
  //
  // Cartesian product of every overlay entry × {direct, proxy}. Only runs
  // when at least one fixture exists under `__fixtures__/` (produced by
  // `scripts/validate-image-models.ts` — operator-run, cost-gated). The
  // fixtures aren't committed to the repo, so in CI the whole describe is
  // skipped with a single skip line — no per-cell skips inflating the
  // output. Run the harness locally and the matrix wakes up.
  //
  // For edit-capable entries, the pair runs a gen-mode prompt and asserts
  // the correct controlAxis param shape + success. For gen-only entries,
  // the pair runs an edit-mode prompt and asserts the capability `err()` —
  // generateImage is never called, so the controlAxis axis is exercised
  // exclusively via edit-capable entries within the same matrix.
  // -------------------------------------------------------------------------

  describe("(model × transport) matrix", () => {
    const TRANSPORTS = ["direct", "proxy"] as const;
    type Transport = (typeof TRANSPORTS)[number];

    const EnvelopeSchema = z.object({
      warnings: z.array(z.unknown()),
      providerMetadata: z.unknown(),
      mediaType: z.string(),
      base64Length: z.number().int().nonnegative(),
      imageCount: z.number().int().nonnegative(),
    });
    const FixtureSchema = z.object({
      direct: EnvelopeSchema.nullable(),
      proxy: EnvelopeSchema.nullable(),
    });

    const FIXTURES_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__");
    const fixturesExist =
      existsSync(FIXTURES_DIR) && readdirSync(FIXTURES_DIR).some((f) => f.endsWith(".json"));

    /**
     * Resolve `provider:model` to its fixture path. The harness writes with
     * `__` separator because `:` isn't filesystem-safe; mirror that here.
     */
    function fixturePathFor(id: string): string {
      return resolve(FIXTURES_DIR, `${id.replace(":", "__")}.json`);
    }

    /**
     * Returns the parsed fixture, or `null` when the file is absent. Bad JSON
     * or shape mismatches throw — the harness's contract is the source of
     * truth and a broken fixture should fail loudly, not skip silently.
     */
    function loadFixture(id: string): z.infer<typeof FixtureSchema> | null {
      const p = fixturePathFor(id);
      if (!existsSync(p)) return null;
      return FixtureSchema.parse(JSON.parse(readFileSync(p, "utf-8")));
    }

    /**
     * Synthesize PNG bytes for the mocked generateImage response. The agent
     * only copies these bytes into an artifact — it doesn't validate PNG
     * structure — so an 8-byte signature is enough to exercise the code path.
     */
    function synthesizePngBytes(): Uint8Array {
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    }

    if (!fixturesExist) {
      // CI path: no fixtures committed. Register exactly one skip so the
      // test output doesn't inflate with N per-cell skips that assert
      // nothing. Run `scripts/validate-image-models.ts` locally to wake
      // the full matrix.
      test.skip("fixtures not committed; run validate-image-models.ts locally", () => {});
      return;
    }

    for (const entry of listImageEntries()) {
      for (const transport of TRANSPORTS satisfies readonly Transport[]) {
        const label = `${entry.id} · ${transport}`;
        const fixture = loadFixture(entry.id);

        if (fixture === null) {
          test.skip(`${label} · skipped (no fixture file)`, () => {});
          continue;
        }
        const envelope = fixture[transport];
        if (envelope === null) {
          test.skip(`${label} · skipped (${transport} fixture null)`, () => {});
          continue;
        }

        if (entry.capabilities.edit) {
          test(`${label} · dispatches ${entry.defaults.controlAxis} param`, async () => {
            useImageModel(entry.id);
            const bytes = synthesizePngBytes();
            const imageFile = {
              uint8Array: bytes,
              mediaType: envelope.mediaType,
              base64: uint8ToBase64(bytes),
            };
            generateImageMock.mockResolvedValue({
              image: imageFile,
              images: [imageFile],
              warnings: envelope.warnings,
              responses: [],
              providerMetadata: envelope.providerMetadata,
            });
            setupSaveMocks();

            const result = await imageGenerationAgent.execute("Generate an image", makeContext());

            expect(result.ok).toBe(true);
            const call = generateImageMock.mock.calls[0]?.[0];
            if (entry.defaults.controlAxis === "size") {
              expect(call.size).toBe(entry.defaults.size);
              expect(call.aspectRatio).toBeUndefined();
            } else {
              expect(call.aspectRatio).toBe(entry.defaults.aspectRatio);
              expect(call.size).toBeUndefined();
            }
          });
        } else {
          test(`${label} · returns err on edit prompt (gen-only)`, async () => {
            useImageModel(entry.id);
            discoverImageFilesMock.mockResolvedValue(makeDiscoveryResult([{ id: "src-art-1" }]));

            const result = await imageGenerationAgent.execute(
              "Edit the sky src-art-1",
              makeContext(),
            );

            expect(result.ok).toBe(false);
            expect.assert(result.ok === false);
            expect(result.error.reason).toContain(entry.displayName);
            expect(result.error.reason).toContain("supports generation only");
            expect(generateImageMock).not.toHaveBeenCalled();
          });
        }
      }
    }
  });
});
