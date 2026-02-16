/**
 * Tests for buildContextPrompt image orchestration.
 *
 * Since buildContextPrompt is private, we test through the public LLM action
 * execution path: create an FSM with an LLM action, provide a mock artifactStorage,
 * and verify the messages param passed to the mock LLMProvider.
 *
 * expandArtifactRefsInDocuments is mocked because it calls the daemon HTTP API
 * which isn't available in unit tests. The image resolution path under test
 * is separate: it uses extractRefs + artifactStorage directly.
 */

import type { Artifact, ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { CoreMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMProvider, OutputValidator } from "../types.ts";

// Mock expandArtifactRefsInDocuments to avoid hitting the daemon HTTP API.
// This returns documents unchanged — artifact expansion isn't what we're testing.
vi.mock("../artifact-expansion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artifact-expansion.ts")>();
  return { ...actual, expandArtifactRefsInDocuments: vi.fn((docs) => Promise.resolve(docs)) };
});

/** Minimal FSM: pending --RUN--> done, with an LLM action referencing a document with an artifactRef. */
function makeFSM(): FSMDefinition {
  return {
    id: "image-ctx-test",
    initial: "pending",
    states: {
      pending: {
        documents: [
          {
            id: "img-doc",
            type: "ImageDoc",
            data: {
              summary: "Has an image ref",
              artifactRef: { id: "art-img-1", type: "file", summary: "A photo" },
            },
          },
        ],
        on: {
          RUN: {
            target: "done",
            actions: [
              { type: "llm", provider: "test", model: "test-model", prompt: "Describe the image" },
            ],
          },
        },
      },
      done: { type: "final" },
    },
  };
}

/** Fake image bytes — content doesn't matter, just needs to be non-empty. */
const FAKE_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeImageArtifact(id: string): Artifact {
  return {
    id,
    type: "file",
    title: "photo.png",
    summary: "A test photo",
    revision: 1,
    createdAt: new Date().toISOString(),
    data: {
      type: "file",
      version: 1,
      data: {
        path: `/artifacts/${id}/photo.png`,
        mimeType: "image/png",
        originalName: "photo.png",
      },
    },
  };
}

const notImplemented = { ok: false as const, error: "not implemented" };

/** Build a mock storage adapter with configurable getManyLatest and readBinaryContents. */
function makeMockStorage(overrides: {
  getManyLatest?: ArtifactStorageAdapter["getManyLatest"];
  readBinaryContents?: ArtifactStorageAdapter["readBinaryContents"];
}): ArtifactStorageAdapter {
  return {
    create: () => Promise.resolve(notImplemented),
    update: () => Promise.resolve(notImplemented),
    get: () => Promise.resolve({ ok: true, data: null }),
    deleteArtifact: () => Promise.resolve({ ok: true, data: undefined }),
    getManyLatest: overrides.getManyLatest ?? (() => Promise.resolve({ ok: true, data: [] })),
    readBinaryContents:
      overrides.readBinaryContents ?? (() => Promise.resolve({ ok: false, error: "not found" })),
    readDatabasePreview: () => Promise.resolve(notImplemented),
    readFileContents: () => Promise.resolve(notImplemented),
    listAll: () => Promise.resolve({ ok: true, data: [] }),
    listByWorkspace: () => Promise.resolve({ ok: true, data: [] }),
    listByChat: () => Promise.resolve({ ok: true, data: [] }),
    downloadDatabaseFile: () => Promise.resolve(notImplemented),
  };
}

interface CapturedCall {
  prompt: string;
  messages: CoreMessage[] | undefined;
}

async function setupEngine(opts: {
  artifactStorage?: ArtifactStorageAdapter;
  validateOutput?: OutputValidator;
}) {
  const store = new InMemoryDocumentStore();
  const scope = { workspaceId: "test", sessionId: "test-session" };
  const captured: CapturedCall[] = [];

  const mockLLMProvider: LLMProvider = {
    call: (params) => {
      captured.push({ prompt: params.prompt, messages: params.messages });
      const result: import("@atlas/agent-sdk").AgentResult<string, FSMLLMOutput> = {
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: true,
        data: { response: "I see an image" },
        toolCalls: [],
        durationMs: 0,
      };
      return Promise.resolve(result);
    },
  };

  const engine = new FSMEngine(makeFSM(), {
    documentStore: store,
    scope,
    llmProvider: mockLLMProvider,
    artifactStorage: opts.artifactStorage,
    validateOutput: opts.validateOutput,
  });
  await engine.initialize();

  return { engine, captured };
}

describe("buildContextPrompt image orchestration", () => {
  it("no artifactStorage — LLM receives messages: undefined (prompt-only path)", async () => {
    const { engine, captured } = await setupEngine({});

    await engine.signal({ type: "RUN" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.messages).toBeUndefined();
    expect(captured[0]?.prompt).toContain("Describe the image");
  });

  it("with artifactStorage + image artifact — LLM receives messages with ImagePart", async () => {
    const storage = makeMockStorage({
      getManyLatest: ({ ids }) => {
        const artifacts = ids.filter((id) => id === "art-img-1").map((id) => makeImageArtifact(id));
        return Promise.resolve({ ok: true, data: artifacts });
      },
      readBinaryContents: ({ id }) => {
        if (id === "art-img-1") {
          return Promise.resolve({ ok: true, data: FAKE_IMAGE_BYTES });
        }
        return Promise.resolve({ ok: false, error: "not found" });
      },
    });

    const { engine, captured } = await setupEngine({ artifactStorage: storage });

    await engine.signal({ type: "RUN" });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.messages).toBeDefined();
    expect(call?.messages).toHaveLength(1);

    const msg = call?.messages?.[0];
    expect(msg?.role).toBe("user");

    // Content should include both text and image parts
    const content = msg?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;

    const textParts = content.filter((p) => p.type === "text");
    const imageParts = content.filter((p) => p.type === "image");

    expect(textParts.length).toBeGreaterThan(0);
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]).toMatchObject({
      type: "image",
      image: FAKE_IMAGE_BYTES,
      mediaType: "image/png",
    });
  });

  it("with artifactStorage + binary read fails — falls back to text in prompt", async () => {
    const storage = makeMockStorage({
      getManyLatest: ({ ids }) => {
        const artifacts = ids.filter((id) => id === "art-img-1").map((id) => makeImageArtifact(id));
        return Promise.resolve({ ok: true, data: artifacts });
      },
      readBinaryContents: () => {
        return Promise.resolve({ ok: false, error: "Storage read failed" });
      },
    });

    const { engine, captured } = await setupEngine({ artifactStorage: storage });

    await engine.signal({ type: "RUN" });

    expect(captured).toHaveLength(1);
    const call = captured[0];

    // No images resolved → messages should be undefined (prompt-only path)
    expect(call?.messages).toBeUndefined();

    // The text fallback from resolveImageParts should be appended to the prompt
    expect(call?.prompt).toContain("[Image: photo.png — could not be loaded]");
  });

  it("retry after validation failure preserves image context", async () => {
    const storage = makeMockStorage({
      getManyLatest: ({ ids }) => {
        const artifacts = ids.filter((id) => id === "art-img-1").map((id) => makeImageArtifact(id));
        return Promise.resolve({ ok: true, data: artifacts });
      },
      readBinaryContents: ({ id }) => {
        if (id === "art-img-1") {
          return Promise.resolve({ ok: true, data: FAKE_IMAGE_BYTES });
        }
        return Promise.resolve({ ok: false, error: "not found" });
      },
    });

    // Validator fails on first call, passes on second
    let validationCallCount = 0;
    const validator: OutputValidator = () => {
      validationCallCount++;
      if (validationCallCount === 1) {
        return Promise.resolve({ valid: false, feedback: "Try again with more detail" });
      }
      return Promise.resolve({ valid: true });
    };

    const { engine, captured } = await setupEngine({
      artifactStorage: storage,
      validateOutput: validator,
    });

    await engine.signal({ type: "RUN" });

    // Should have 2 LLM calls: initial + retry
    expect(captured).toHaveLength(2);

    // First call should have images
    const firstCall = captured[0];
    expect(firstCall?.messages).toBeDefined();
    const firstContent = firstCall?.messages?.[0]?.content;
    expect(Array.isArray(firstContent)).toBe(true);
    if (Array.isArray(firstContent)) {
      expect(firstContent.some((p) => p.type === "image")).toBe(true);
    }

    // Retry call should also have images (not dropped)
    const retryCall = captured[1];
    expect(retryCall?.messages).toBeDefined();
    const retryContent = retryCall?.messages?.[0]?.content;
    expect(Array.isArray(retryContent)).toBe(true);
    if (Array.isArray(retryContent)) {
      const retryImages = retryContent.filter((p) => p.type === "image");
      expect(retryImages).toHaveLength(1);
      expect(retryImages[0]).toMatchObject({
        type: "image",
        image: FAKE_IMAGE_BYTES,
        mediaType: "image/png",
      });
    }

    // Retry prompt should contain validation feedback
    expect(retryCall?.prompt).toContain("validation-feedback");
    expect(retryCall?.prompt).toContain("Try again with more detail");
  });
});
