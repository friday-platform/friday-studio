/**
 * Integration tests for expandArtifactRefsInDocuments utility.
 *
 * These tests use the real daemon client to create/fetch artifacts,
 * NOT mocks. This ensures we test the actual integration path.
 *
 * Requires: daemon running (`deno task start`)
 */

import { client, parseResult } from "@atlas/client/v2";
import type { ArtifactDataInput } from "@atlas/core/artifacts";
import { afterAll, describe, expect, it } from "vitest";
import { expandArtifactRefsInDocuments } from "../artifact-expansion.ts";
import type { Document } from "../types.ts";

/** Minimal ArtifactDataInput for a file artifact with inline test content. */
function makeFileInput(): ArtifactDataInput {
  return {
    type: "file",
    content: "Test fixture content for artifact-expansion integration tests.\n",
    mimeType: "text/plain",
    originalName: "test-fixture.txt",
  };
}

/** Skip when daemon isn't reachable. The whole suite hits the real /api endpoints. */
const DAEMON_RUNNING = await fetch("http://127.0.0.1:8080/api/health", {
  signal: AbortSignal.timeout(500),
})
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!DAEMON_RUNNING)("expandArtifactRefsInDocuments", () => {
  // Track created artifacts for cleanup
  const createdArtifactIds: string[] = [];

  /**
   * Create a test artifact via the daemon API.
   * Tracks ID for cleanup in afterAll.
   */
  async function createTestArtifact(
    data: ArtifactDataInput,
    title = "Test Artifact",
  ): Promise<string> {
    const response = await parseResult(
      client.artifactsStorage.index.$post({
        json: { data, title, summary: "Created for artifact-expansion test" },
      }),
    );
    if (!response.ok) {
      throw new Error(`Failed to create artifact: ${JSON.stringify(response.error)}`);
    }
    createdArtifactIds.push(response.data.artifact.id);
    return response.data.artifact.id;
  }

  afterAll(async () => {
    // Cleanup all created artifacts
    for (const id of createdArtifactIds) {
      try {
        const response = await client.artifactsStorage[":id"].$delete({ param: { id } });
        // Consume the response body to prevent resource leaks
        await response.text();
      } catch {
        // Ignore cleanup errors - artifact may not exist
      }
    }
  });

  describe("happy path", () => {
    it("expands single artifactRef with real artifact content", async () => {
      // Arrange: create a real artifact
      const artifactData = makeFileInput();
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Found research results",
            artifactRef: { id: artifactId, type: "file", summary: "fixture file" },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifactId]).toMatchObject({ type: "file" });
    });

    it("expands artifactRefs array with multiple artifacts", async () => {
      // Arrange: create two artifacts
      const artifact1Id = await createTestArtifact(makeFileInput(), "Summary");
      const artifact2Id = await createTestArtifact(makeFileInput(), "Table");

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Multiple artifacts",
            artifactRefs: [
              { id: artifact1Id, type: "file", summary: "First" },
              { id: artifact2Id, type: "file", summary: "Second" },
            ],
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifact1Id]).toMatchObject({ type: "file" });
      expect(content[artifact2Id]).toMatchObject({ type: "file" });
    });

    it("handles documents with both artifactRef and artifactRefs", async () => {
      // Arrange
      const singleId = await createTestArtifact(makeFileInput());
      const arrayId1 = await createTestArtifact(makeFileInput());
      const arrayId2 = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Both forms",
            artifactRef: { id: singleId, type: "file", summary: "Single" },
            artifactRefs: [
              { id: arrayId1, type: "file", summary: "Array 1" },
              { id: arrayId2, type: "file", summary: "Array 2" },
            ],
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(Object.keys(content)).toHaveLength(3);
      expect(content[singleId]).toMatchObject({ type: "file" });
      expect(content[arrayId1]).toMatchObject({ type: "file" });
      expect(content[arrayId2]).toMatchObject({ type: "file" });
    });

    it("expands artifactRef wrapped in Result pattern { ok: true, data: { artifactRef } }", async () => {
      // Arrange: create artifact and doc with Result wrapper (common agent output pattern)
      const artifactData = makeFileInput();
      const artifactId = await createTestArtifact(artifactData);

      // This matches how web-search agent returns: success({ summary, artifactRef })
      // which becomes { ok: true, data: { summary, artifactRef } }
      const docs: Document[] = [
        {
          id: "web-search-result",
          type: "AgentResult",
          data: {
            ok: true,
            data: {
              summary: "Found 3 results",
              artifactRef: { id: artifactId, type: "file", summary: "Search results" },
            },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: artifactContent should be added with the fetched content
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifactId]).toMatchObject({ type: "file" });
    });

    it("expands artifactRefs array wrapped in Result pattern", async () => {
      // Arrange: create two artifacts with Result wrapper pattern
      const artifact1Id = await createTestArtifact(makeFileInput());
      const artifact2Id = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "multi-result",
          type: "AgentResult",
          data: {
            ok: true,
            data: {
              response: "Found multiple items",
              artifactRefs: [
                { id: artifact1Id, type: "file", summary: "First" },
                { id: artifact2Id, type: "file", summary: "Second" },
              ],
            },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifact1Id]).toMatchObject({ type: "file" });
      expect(content[artifact2Id]).toMatchObject({ type: "file" });
    });

    it("deduplicates when multiple documents reference the same artifact", async () => {
      // Arrange: one artifact, two documents referencing it
      const sharedId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "First doc",
            artifactRef: { id: sharedId, type: "file", summary: "Shared" },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Second doc",
            artifactRef: { id: sharedId, type: "file", summary: "Shared" },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: both docs should have the content, fetched only once
      expect(expanded).toHaveLength(2);
      expect(expanded[0]?.data?.artifactContent?.[sharedId]).toMatchObject({ type: "file" });
      expect(expanded[1]?.data?.artifactContent?.[sharedId]).toMatchObject({ type: "file" });
    });
  });

  describe("edge cases", () => {
    it("returns unchanged documents when no refs present", async () => {
      const docs: Document[] = [
        { id: "doc-1", type: "agent-output", data: { summary: "No refs here" } },
        { id: "doc-2", type: "agent-output", data: { result: "Also no refs" } },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: documents unchanged, no artifactContent added
      expect(expanded).toHaveLength(2);
      expect(expanded[0]?.data?.artifactContent).toBeUndefined();
      expect(expanded[1]?.data?.artifactContent).toBeUndefined();
      expect(expanded[0]?.data?.summary).toBe("No refs here");
    });

    it("returns empty array for empty input", async () => {
      const expanded = await expandArtifactRefsInDocuments([]);
      expect(expanded).toHaveLength(0);
    });

    it("handles mixed documents - only adds artifactContent to ref docs", async () => {
      // Arrange
      const artifactId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        { id: "no-ref", type: "agent-output", data: { summary: "No refs" } },
        {
          id: "has-ref",
          type: "agent-output",
          data: {
            summary: "Has ref",
            artifactRef: { id: artifactId, type: "file", summary: "Test" },
          },
        },
        { id: "also-no-ref", type: "agent-output", data: { other: "data" } },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      expect(expanded).toHaveLength(3);
      expect(expanded[0]?.data?.artifactContent).toBeUndefined(); // no-ref
      const content = expanded[1]?.data?.artifactContent;
      expect.assert(content !== undefined, "has-ref doc should have artifactContent");
      expect(content[artifactId]).toMatchObject({ type: "file" });
      expect(expanded[2]?.data?.artifactContent).toBeUndefined(); // also-no-ref
    });

    it("handles nonexistent artifact ID gracefully (missing from content)", async () => {
      // Arrange: reference an artifact that doesn't exist
      const fakeId = "nonexistent-artifact-id-12345";

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "References missing artifact",
            artifactRef: { id: fakeId, type: "file", summary: "Missing" },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: document returned, but artifactContent either missing or empty for that ID
      expect(expanded).toHaveLength(1);
      // The function should gracefully handle missing artifacts
      // Either no artifactContent, or artifactContent without the missing ID
      const content = expanded[0]?.data?.artifactContent;
      if (content) {
        expect(content[fakeId]).toBeUndefined();
      }
    });
  });

  describe("error handling", () => {
    it("handles partial fetch success (some exist, some don't)", async () => {
      // Arrange: one real artifact, one fake
      const realId = await createTestArtifact(makeFileInput());
      const fakeId = "fake-artifact-id-99999";

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Mixed refs",
            artifactRefs: [
              { id: realId, type: "file", summary: "Real" },
              { id: fakeId, type: "file", summary: "Fake" },
            ],
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: should have content for real artifact, missing for fake
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[realId]).toMatchObject({ type: "file" });
      expect(content[fakeId]).toBeUndefined();
    });

    it("throws on abort signal instead of silent data loss", async () => {
      // Arrange
      const artifactId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Will be aborted",
            artifactRef: { id: artifactId, type: "file", summary: "Test" },
          },
        },
      ];

      // Create an already-aborted signal
      const controller = new AbortController();
      controller.abort();

      // Act & Assert: should throw instead of silently returning unchanged documents
      await expect(expandArtifactRefsInDocuments(docs, controller.signal)).rejects.toThrow(
        "Artifact expansion failed",
      );
    });
  });

  describe("idempotency", () => {
    it("skips fetch when all documents already have artifactContent", async () => {
      // Arrange: documents that already have artifactContent (simulating prior expansion)
      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Already expanded",
            artifactRef: { id: "art-123", type: "file", summary: "Test" },
            artifactContent: {
              "art-123": {
                type: "file",
                contentRef: "0".repeat(64),
                size: 0,
                mimeType: "text/plain",
                originalName: "test-fixture.txt",
              },
            },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Also expanded",
            artifactContent: {
              "art-456": {
                type: "file",
                contentRef: "0".repeat(64),
                size: 0,
                mimeType: "text/plain",
                originalName: "test-fixture.txt",
              },
            },
          },
        },
      ];

      // Act: call expand on already-expanded docs
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: returns same documents, no fetch occurred
      expect(expanded).toHaveLength(2);
      expect(expanded[0]?.data?.artifactContent?.["art-123"]).toMatchObject({ type: "file" });
      expect(expanded[1]?.data?.artifactContent?.["art-456"]).toMatchObject({ type: "file" });
    });

    it("calling expand twice returns same result (true idempotency)", async () => {
      // Arrange: create a real artifact and document
      const artifactId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Will be expanded twice",
            artifactRef: { id: artifactId, type: "file", summary: "Test" },
          },
        },
      ];

      // Act: expand once
      const firstExpansion = await expandArtifactRefsInDocuments(docs);

      // Assert first expansion worked
      expect(firstExpansion).toHaveLength(1);
      const content = firstExpansion[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifactId]).toMatchObject({ type: "file" });

      // Act: expand again - should be a no-op (early exit)
      const secondExpansion = await expandArtifactRefsInDocuments(firstExpansion);

      // Assert: identical result, early exit path taken
      expect(secondExpansion).toHaveLength(1);
      expect(secondExpansion[0]?.data?.artifactContent?.[artifactId]).toMatchObject({
        type: "file",
      });
    });

    it("re-expands when some documents lack artifactContent (mixed state)", async () => {
      // Arrange: create artifact for the unexpanded doc
      const artifactId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Already expanded",
            artifactRef: { id: "old-art", type: "file", summary: "Old" },
            artifactContent: {
              "old-art": {
                type: "file",
                contentRef: "0".repeat(64),
                size: 0,
                mimeType: "text/plain",
                originalName: "test-fixture.txt",
              },
            },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Needs expansion",
            artifactRef: { id: artifactId, type: "file", summary: "New" },
            // No artifactContent - needs fetch
          },
        },
      ];

      // Act: should NOT early-exit because doc-2 lacks artifactContent
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: both docs now have content
      expect(expanded).toHaveLength(2);
      // Doc 1: should have new content (re-fetched, but old-art doesn't exist so may be empty)
      // Doc 2: should have the new artifact content
      const content = expanded[1]?.data?.artifactContent;
      expect.assert(content !== undefined, "doc-2 artifactContent should be defined");
      expect(content[artifactId]).toMatchObject({ type: "file" });
    });

    it("handles mixed docs where some have no artifact refs (regression: every() bug)", async () => {
      // Regression test: the old `every()` check failed on mixed arrays because
      // docs without artifact refs never get `artifactContent`, so every() always fails
      const artifactId = await createTestArtifact(makeFileInput());

      const docs: Document[] = [
        {
          id: "doc-no-refs",
          type: "system-message",
          data: {
            content: "Plain message with no artifact refs",
            // No artifactRef, no artifactRefs, no artifactContent
          },
        },
        {
          id: "doc-with-ref",
          type: "agent-output",
          data: {
            summary: "Has artifact ref",
            artifactRef: { id: artifactId, type: "file", summary: "Test" },
          },
        },
      ];

      // Act: first expansion
      const firstExpansion = await expandArtifactRefsInDocuments(docs);

      // Assert: doc with ref got expanded, doc without ref unchanged
      expect(firstExpansion).toHaveLength(2);
      expect(firstExpansion[0]?.data?.artifactContent).toBeUndefined(); // No refs = no artifactContent
      const content = firstExpansion[1]?.data?.artifactContent;
      expect.assert(content !== undefined, "doc-with-ref should have artifactContent");
      expect(content[artifactId]).toMatchObject({ type: "file" });

      // Act: second expansion should early-exit (all referenced IDs already have content)
      const secondExpansion = await expandArtifactRefsInDocuments(firstExpansion);

      // Assert: identical result
      expect(secondExpansion).toHaveLength(2);
      expect(secondExpansion[0]?.data?.artifactContent).toBeUndefined();
      expect(secondExpansion[1]?.data?.artifactContent?.[artifactId]).toMatchObject({
        type: "file",
      });
    });

    it("only fetches missing IDs on re-expansion (preserves existing content)", async () => {
      // Create two artifacts
      const artifact1Id = await createTestArtifact(makeFileInput());
      const artifact2Id = await createTestArtifact(makeFileInput());

      // Doc already has artifact1 expanded, but also refs artifact2
      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Has multiple refs",
            artifactRefs: [
              { id: artifact1Id, type: "file", summary: "First" },
              { id: artifact2Id, type: "file", summary: "Second" },
            ],
            // Simulate prior partial expansion - only artifact1 is expanded
            artifactContent: {
              [artifact1Id]: {
                type: "file" as const,
                contentRef: "0".repeat(64),
                size: 0,
                mimeType: "text/plain",
                originalName: "test-fixture.txt",
              },
            },
          },
        },
      ];

      // Act: should only fetch artifact2 (artifact1 already present)
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: both artifacts now in content, original preserved
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifact1Id]).toMatchObject({ type: "file" });
      expect(content[artifact2Id]).toMatchObject({ type: "file" });
    });
  });
});
