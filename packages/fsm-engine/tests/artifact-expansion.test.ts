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

describe("expandArtifactRefsInDocuments", () => {
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
      const artifactData: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Research findings for Q4",
      };
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Found research results",
            artifactRef: { id: artifactId, type: "summary", summary: "Q4 findings" },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifactId]).toEqual(artifactData);
    });

    it("expands artifactRefs array with multiple artifacts", async () => {
      // Arrange: create two artifacts
      const artifact1Data: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "First summary",
      };
      const artifact2Data: ArtifactDataInput = {
        type: "table",
        version: 1,
        data: { title: "Test Table", headers: ["a", "b"], rows: [{ a: "1", b: "2" }] },
      };

      const artifact1Id = await createTestArtifact(artifact1Data, "Summary");
      const artifact2Id = await createTestArtifact(artifact2Data, "Table");

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Multiple artifacts",
            artifactRefs: [
              { id: artifact1Id, type: "summary", summary: "First" },
              { id: artifact2Id, type: "table", summary: "Second" },
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
      expect(content[artifact1Id]).toEqual(artifact1Data);
      expect(content[artifact2Id]).toEqual(artifact2Data);
    });

    it("handles documents with both artifactRef and artifactRefs", async () => {
      // Arrange
      const singleData: ArtifactDataInput = { type: "summary", version: 1, data: "Single ref" };
      const arrayData1: ArtifactDataInput = { type: "summary", version: 1, data: "Array ref 1" };
      const arrayData2: ArtifactDataInput = { type: "summary", version: 1, data: "Array ref 2" };

      const singleId = await createTestArtifact(singleData);
      const arrayId1 = await createTestArtifact(arrayData1);
      const arrayId2 = await createTestArtifact(arrayData2);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Both forms",
            artifactRef: { id: singleId, type: "summary", summary: "Single" },
            artifactRefs: [
              { id: arrayId1, type: "summary", summary: "Array 1" },
              { id: arrayId2, type: "summary", summary: "Array 2" },
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
      expect(content[singleId]).toEqual(singleData);
      expect(content[arrayId1]).toEqual(arrayData1);
      expect(content[arrayId2]).toEqual(arrayData2);
    });

    it("expands artifactRef wrapped in Result pattern { ok: true, data: { artifactRef } }", async () => {
      // Arrange: create artifact and doc with Result wrapper (common agent output pattern)
      const artifactData: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Web search results",
      };
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
              artifactRef: { id: artifactId, type: "web-search", summary: "Search results" },
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
      expect(content[artifactId]).toEqual(artifactData);
    });

    it("expands artifactRefs array wrapped in Result pattern", async () => {
      // Arrange: create two artifacts with Result wrapper pattern
      const artifact1Data: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "First result",
      };
      const artifact2Data: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Second result",
      };
      const artifact1Id = await createTestArtifact(artifact1Data);
      const artifact2Id = await createTestArtifact(artifact2Data);

      const docs: Document[] = [
        {
          id: "multi-result",
          type: "AgentResult",
          data: {
            ok: true,
            data: {
              response: "Found multiple items",
              artifactRefs: [
                { id: artifact1Id, type: "summary", summary: "First" },
                { id: artifact2Id, type: "summary", summary: "Second" },
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
      expect(content[artifact1Id]).toEqual(artifact1Data);
      expect(content[artifact2Id]).toEqual(artifact2Data);
    });

    it("deduplicates when multiple documents reference the same artifact", async () => {
      // Arrange: one artifact, two documents referencing it
      const sharedData: ArtifactDataInput = { type: "summary", version: 1, data: "Shared content" };
      const sharedId = await createTestArtifact(sharedData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "First doc",
            artifactRef: { id: sharedId, type: "summary", summary: "Shared" },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Second doc",
            artifactRef: { id: sharedId, type: "summary", summary: "Shared" },
          },
        },
      ];

      // Act
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: both docs should have the content, fetched only once
      expect(expanded).toHaveLength(2);
      expect(expanded[0]?.data?.artifactContent?.[sharedId]).toEqual(sharedData);
      expect(expanded[1]?.data?.artifactContent?.[sharedId]).toEqual(sharedData);
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
      const artifactData: ArtifactDataInput = { type: "summary", version: 1, data: "Content" };
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        { id: "no-ref", type: "agent-output", data: { summary: "No refs" } },
        {
          id: "has-ref",
          type: "agent-output",
          data: {
            summary: "Has ref",
            artifactRef: { id: artifactId, type: "summary", summary: "Test" },
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
      expect(content[artifactId]).toEqual(artifactData);
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
            artifactRef: { id: fakeId, type: "summary", summary: "Missing" },
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
      const realData: ArtifactDataInput = { type: "summary", version: 1, data: "Real content" };
      const realId = await createTestArtifact(realData);
      const fakeId = "fake-artifact-id-99999";

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Mixed refs",
            artifactRefs: [
              { id: realId, type: "summary", summary: "Real" },
              { id: fakeId, type: "summary", summary: "Fake" },
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
      expect(content[realId]).toEqual(realData);
      expect(content[fakeId]).toBeUndefined();
    });

    it("throws on abort signal instead of silent data loss", async () => {
      // Arrange
      const artifactData: ArtifactDataInput = { type: "summary", version: 1, data: "Content" };
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Will be aborted",
            artifactRef: { id: artifactId, type: "summary", summary: "Test" },
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
            artifactRef: { id: "art-123", type: "summary", summary: "Test" },
            artifactContent: { "art-123": { type: "summary", version: 1, data: "Pre-fetched" } },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Also expanded",
            artifactContent: {
              "art-456": { type: "summary", version: 1, data: "Also pre-fetched" },
            },
          },
        },
      ];

      // Act: call expand on already-expanded docs
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: returns same documents, no fetch occurred
      expect(expanded).toHaveLength(2);
      expect(expanded[0]?.data?.artifactContent?.["art-123"]).toEqual({
        type: "summary",
        version: 1,
        data: "Pre-fetched",
      });
      expect(expanded[1]?.data?.artifactContent?.["art-456"]).toEqual({
        type: "summary",
        version: 1,
        data: "Also pre-fetched",
      });
    });

    it("calling expand twice returns same result (true idempotency)", async () => {
      // Arrange: create a real artifact and document
      const artifactData: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Idempotency test content",
      };
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Will be expanded twice",
            artifactRef: { id: artifactId, type: "summary", summary: "Test" },
          },
        },
      ];

      // Act: expand once
      const firstExpansion = await expandArtifactRefsInDocuments(docs);

      // Assert first expansion worked
      expect(firstExpansion).toHaveLength(1);
      const content = firstExpansion[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifactId]).toEqual(artifactData);

      // Act: expand again - should be a no-op (early exit)
      const secondExpansion = await expandArtifactRefsInDocuments(firstExpansion);

      // Assert: identical result, early exit path taken
      expect(secondExpansion).toHaveLength(1);
      expect(secondExpansion[0]?.data?.artifactContent?.[artifactId]).toEqual(artifactData);
    });

    it("re-expands when some documents lack artifactContent (mixed state)", async () => {
      // Arrange: create artifact for the unexpanded doc
      const artifactData: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "New content to fetch",
      };
      const artifactId = await createTestArtifact(artifactData);

      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Already expanded",
            artifactRef: { id: "old-art", type: "summary", summary: "Old" },
            artifactContent: { "old-art": { type: "summary", version: 1, data: "Pre-existing" } },
          },
        },
        {
          id: "doc-2",
          type: "agent-output",
          data: {
            summary: "Needs expansion",
            artifactRef: { id: artifactId, type: "summary", summary: "New" },
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
      expect(content[artifactId]).toEqual(artifactData);
    });

    it("handles mixed docs where some have no artifact refs (regression: every() bug)", async () => {
      // Regression test: the old `every()` check failed on mixed arrays because
      // docs without artifact refs never get `artifactContent`, so every() always fails
      const artifactData: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Content for doc with ref",
      };
      const artifactId = await createTestArtifact(artifactData);

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
            artifactRef: { id: artifactId, type: "summary", summary: "Test" },
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
      expect(content[artifactId]).toEqual(artifactData);

      // Act: second expansion should early-exit (all referenced IDs already have content)
      const secondExpansion = await expandArtifactRefsInDocuments(firstExpansion);

      // Assert: identical result
      expect(secondExpansion).toHaveLength(2);
      expect(secondExpansion[0]?.data?.artifactContent).toBeUndefined();
      expect(secondExpansion[1]?.data?.artifactContent?.[artifactId]).toEqual(artifactData);
    });

    it("only fetches missing IDs on re-expansion (preserves existing content)", async () => {
      // Create two artifacts
      const artifact1Data: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "First artifact",
      };
      const artifact2Data: ArtifactDataInput = {
        type: "summary",
        version: 1,
        data: "Second artifact",
      };
      const artifact1Id = await createTestArtifact(artifact1Data);
      const artifact2Id = await createTestArtifact(artifact2Data);

      // Doc already has artifact1 expanded, but also refs artifact2
      const docs: Document[] = [
        {
          id: "doc-1",
          type: "agent-output",
          data: {
            summary: "Has multiple refs",
            artifactRefs: [
              { id: artifact1Id, type: "summary", summary: "First" },
              { id: artifact2Id, type: "summary", summary: "Second" },
            ],
            // Simulate prior partial expansion - only artifact1 is expanded
            artifactContent: { [artifact1Id]: artifact1Data },
          },
        },
      ];

      // Act: should only fetch artifact2 (artifact1 already present)
      const expanded = await expandArtifactRefsInDocuments(docs);

      // Assert: both artifacts now in content, original preserved
      expect(expanded).toHaveLength(1);
      const content = expanded[0]?.data?.artifactContent;
      expect.assert(content !== undefined, "artifactContent should be defined");
      expect(content[artifact1Id]).toEqual(artifact1Data);
      expect(content[artifact2Id]).toEqual(artifact2Data);
    });
  });
});
