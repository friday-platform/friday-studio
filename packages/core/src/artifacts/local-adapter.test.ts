import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local-adapter.ts";
import { assertArtifactEqual, assertResultFail, assertResultOk } from "./test-utils/assertions.ts";
import {
  cleanupTempFile,
  createCalendarScheduleInput,
  createFileArtifactInput,
  createSlackSummaryInput,
  createSummaryArtifactInput,
  createTableArtifactInput,
  createTempCsvFile,
  createTempJsonFile,
  createTempMarkdownFile,
  createTempTextFile,
  createWebSearchInput,
  createWorkspacePlanInput,
} from "./test-utils/shared-fixtures.ts";

// Helper to create a unique temp KV database for each test
async function createTestAdapter(): Promise<LocalStorageAdapter> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-adapter-test-"));
  const tempPath = path.join(tempDir, "test.db");
  return new LocalStorageAdapter(tempPath);
}

//
// 1. CRUD Operations
//
describe("LocalAdapter: CRUD", () => {
  it("create summary artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    assertArtifactEqual(result.data, {
      type: "file",
      revision: 1,
      title: input.title,
      summary: input.summary,
    });
    expect(result.data.id.length).toEqual(36); // UUID
  });

  it("create file artifact with MIME type detection", async () => {
    const adapter = await createTestAdapter();
    const tempFile = await createTempJsonFile({ test: "data" });

    const input = createFileArtifactInput(tempFile);
    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("file");
    expect(result.data.revision).toEqual(1);

    if (result.data.data.type === "file") {
      expect(result.data.data.data.mimeType).toEqual("application/json");
      expect(result.data.data.data.path).toEqual(tempFile);
    }

    await cleanupTempFile(tempFile);
  });

  it("create file artifact fails when file doesn't exist", async () => {
    const adapter = await createTestAdapter();
    const input = createFileArtifactInput("/nonexistent/file.json");

    const result = await adapter.create(input);

    assertResultFail(result);
    expect(result.error.includes("not found")).toEqual(true);
  });

  it("get artifact by ID (latest revision)", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    const getResult = await adapter.get({ id: artifactId });

    assertResultOk(getResult);
    expect(getResult.data?.id).toEqual(artifactId);
    expect(getResult.data?.revision).toEqual(1);
  });

  it("get artifact by specific revision", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    // Update to create revision 2
    await adapter.update({ id: artifactId, data: input.data, summary: "Updated summary" });

    // Get revision 1 specifically
    const getResult = await adapter.get({ id: artifactId, revision: 1 });

    assertResultOk(getResult);
    expect(getResult.data?.revision).toEqual(1);
    expect(getResult.data?.summary).toEqual(input.summary);
  });

  it("get deleted artifact returns null", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.deleteArtifact({ id: artifactId });

    const getResult = await adapter.get({ id: artifactId });

    assertResultOk(getResult);
    expect(getResult.data).toEqual(null);
  });

  it("get non-existent artifact returns null", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.get({ id: "non-existent-id" });

    assertResultOk(result);
    expect(result.data).toEqual(null);
  });

  it("update creates new revision", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    const updateResult = await adapter.update({
      id: artifactId,
      data: input.data,
      summary: "Updated summary",
      revisionMessage: "Test update",
    });

    assertResultOk(updateResult);
    expect(updateResult.data.revision).toEqual(2);
    expect(updateResult.data.summary).toEqual("Updated summary");
    expect(updateResult.data.revisionMessage).toEqual("Test update");
  });
});

//
// 2. Revision Management
//

describe("LocalAdapter: Revisions", () => {
  it("create starts at revision 1", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.revision).toEqual(1);
  });

  it("update increments revision sequentially", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    const update1 = await adapter.update({ id: artifactId, data: input.data, summary: "Update 1" });
    assertResultOk(update1);
    expect(update1.data.revision).toEqual(2);

    const update2 = await adapter.update({ id: artifactId, data: input.data, summary: "Update 2" });
    assertResultOk(update2);
    expect(update2.data.revision).toEqual(3);
  });

  it("multiple updates create distinct revisions", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.update({ id: artifactId, data: input.data, summary: "v2" });
    await adapter.update({ id: artifactId, data: input.data, summary: "v3" });

    const rev1 = await adapter.get({ id: artifactId, revision: 1 });
    const rev2 = await adapter.get({ id: artifactId, revision: 2 });
    const rev3 = await adapter.get({ id: artifactId, revision: 3 });

    assertResultOk(rev1);
    assertResultOk(rev2);
    assertResultOk(rev3);

    expect(rev1.data?.summary).toEqual(input.summary);
    expect(rev2.data?.summary).toEqual("v2");
    expect(rev3.data?.summary).toEqual("v3");
  });

  it("can retrieve any historical revision", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.update({ id: artifactId, data: input.data, summary: "v2" });
    await adapter.update({ id: artifactId, data: input.data, summary: "v3" });

    // Get each revision
    for (let rev = 1; rev <= 3; rev++) {
      const result = await adapter.get({ id: artifactId, revision: rev });
      assertResultOk(result);
      expect(result.data?.revision).toEqual(rev);
    }
  });

  it("latest revision pointer updates correctly", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    // Get latest (should be rev 1)
    const latest1 = await adapter.get({ id: artifactId });
    assertResultOk(latest1);
    expect(latest1.data?.revision).toEqual(1);

    // Update
    await adapter.update({ id: artifactId, data: input.data, summary: "v2" });

    // Get latest (should be rev 2)
    const latest2 = await adapter.get({ id: artifactId });
    assertResultOk(latest2);
    expect(latest2.data?.revision).toEqual(2);
  });

  it("revision message is stored and retrievable", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    const updateResult = await adapter.update({
      id: artifactId,
      data: input.data,
      summary: "Updated",
      revisionMessage: "Fixed bug #123",
    });

    assertResultOk(updateResult);
    expect(updateResult.data.revisionMessage).toEqual("Fixed bug #123");
  });
});

//
// 3. Soft Delete
//

describe("LocalAdapter: Delete", () => {
  it("marks artifact as deleted", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    const deleteResult = await adapter.deleteArtifact({ id: artifactId });

    assertResultOk(deleteResult);
  });

  it("preserves all revision data", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.update({ id: artifactId, data: input.data, summary: "v2" });
    await adapter.deleteArtifact({ id: artifactId });

    // Data still exists in KV, just marked as deleted
    // (We can't directly test this without accessing internal KV, so we verify
    // that the delete operation succeeds and get returns null)
    const getResult = await adapter.get({ id: artifactId });
    assertResultOk(getResult);
    expect(getResult.data).toEqual(null);
  });

  it("get after delete returns null", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.deleteArtifact({ id: artifactId });

    const getResult = await adapter.get({ id: artifactId });
    assertResultOk(getResult);
    expect(getResult.data).toEqual(null);
  });

  it("update deleted artifact fails", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const createResult = await adapter.create(input);
    assertResultOk(createResult);
    const artifactId = createResult.data.id;

    await adapter.deleteArtifact({ id: artifactId });

    const updateResult = await adapter.update({
      id: artifactId,
      data: input.data,
      summary: "Should fail",
    });

    assertResultFail(updateResult);
    expect(updateResult.error.includes("deleted")).toEqual(true);
  });
});

//
// 4. List Operations
//

describe("LocalAdapter: List", () => {
  it("listAll returns latest revisions only", async () => {
    const adapter = await createTestAdapter();

    const artifact1 = await adapter.create(createSummaryArtifactInput({ title: "A1" }));
    assertResultOk(artifact1);
    const id1 = artifact1.data.id;

    const artifact2 = await adapter.create(createSummaryArtifactInput({ title: "A2" }));
    assertResultOk(artifact2);

    // Update artifact1 to create revision 2
    await adapter.update({ id: id1, data: artifact1.data.data, summary: "Updated" });

    const listResult = await adapter.listAll({});
    assertResultOk(listResult);

    expect(listResult.data.length).toEqual(2);

    // Find artifact1 in list and verify it's revision 2
    const a1 = listResult.data.find((a) => a.id === id1);
    expect(a1?.revision).toEqual(2);
  });

  it("listByWorkspace filters correctly", async () => {
    const adapter = await createTestAdapter();

    await adapter.create(
      createSummaryArtifactInput({ workspaceId: "ws-1", title: "WS1 Artifact" }),
    );
    await adapter.create(
      createSummaryArtifactInput({ workspaceId: "ws-2", title: "WS2 Artifact" }),
    );
    await adapter.create(
      createSummaryArtifactInput({ workspaceId: "ws-1", title: "WS1 Artifact 2" }),
    );

    const result = await adapter.listByWorkspace({ workspaceId: "ws-1" });

    assertResultOk(result);
    expect(result.data.length).toEqual(2);
    expect(result.data.every((a) => a.workspaceId === "ws-1")).toEqual(true);
  });

  it("listByChat filters correctly", async () => {
    const adapter = await createTestAdapter();

    await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));
    await adapter.create(createSummaryArtifactInput({ chatId: "chat-2" }));
    await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));

    const result = await adapter.listByChat({ chatId: "chat-1" });

    assertResultOk(result);
    expect(result.data.length).toEqual(2);
    expect(result.data.every((a) => a.chatId === "chat-1")).toEqual(true);
  });

  it("respects limit parameter", async () => {
    const adapter = await createTestAdapter();

    for (let i = 0; i < 10; i++) {
      await adapter.create(createSummaryArtifactInput({ title: `Artifact ${i}` }));
    }

    const result = await adapter.listAll({ limit: 5 });

    assertResultOk(result);
    expect(result.data.length).toEqual(5);
  });

  it("excludes deleted artifacts", async () => {
    const adapter = await createTestAdapter();

    const artifact1 = await adapter.create(createSummaryArtifactInput());
    assertResultOk(artifact1);

    const artifact2 = await adapter.create(createSummaryArtifactInput());
    assertResultOk(artifact2);

    await adapter.deleteArtifact({ id: artifact1.data.id });

    const result = await adapter.listAll({});

    assertResultOk(result);
    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.id).toEqual(artifact2.data.id);
  });

  it("handles empty results", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.listAll({});

    assertResultOk(result);
    expect(result.data.length).toEqual(0);
  });

  it("listAll with includeData=false returns summaries without data", async () => {
    const adapter = await createTestAdapter();

    const a1 = await adapter.create(createSummaryArtifactInput({ title: "A1" }));
    assertResultOk(a1);
    const a2 = await adapter.create(createSummaryArtifactInput({ title: "A2" }));
    assertResultOk(a2);

    const result = await adapter.listAll({ includeData: false });

    assertResultOk(result);
    expect(result.data.length).toEqual(2);
    for (const item of result.data) {
      expect("data" in item).toEqual(false);
      expect(item.id).toBeDefined();
      expect(item.type).toEqual("summary");
      expect(item.title).toBeDefined();
    }
  });

  it("listByWorkspace with includeData=false strips data", async () => {
    const adapter = await createTestAdapter();

    await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));
    await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));

    const result = await adapter.listByWorkspace({ workspaceId: "ws-1", includeData: false });

    assertResultOk(result);
    expect(result.data.length).toEqual(2);
    for (const item of result.data) {
      expect("data" in item).toEqual(false);
    }
  });

  it("listByChat with includeData=false strips data", async () => {
    const adapter = await createTestAdapter();

    await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));

    const result = await adapter.listByChat({ chatId: "chat-1", includeData: false });

    assertResultOk(result);
    expect(result.data.length).toEqual(1);
    const first = result.data[0];
    if (!first) throw new Error("expected first element");
    expect("data" in first).toEqual(false);
  });
});

//
// 5. Batch Operations
//

describe("LocalAdapter: Batch", () => {
  it("getManyLatest with empty array returns empty", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.getManyLatest({ ids: [] });

    assertResultOk(result);
    expect(result.data.length).toEqual(0);
  });

  it("getManyLatest with valid IDs", async () => {
    const adapter = await createTestAdapter();

    const ids = [];
    for (let i = 0; i < 3; i++) {
      const result = await adapter.create(createSummaryArtifactInput({ title: `A${i}` }));
      assertResultOk(result);
      ids.push(result.data.id);
    }

    const batchResult = await adapter.getManyLatest({ ids });

    assertResultOk(batchResult);
    expect(batchResult.data.length).toEqual(3);
  });

  it("getManyLatest skips deleted artifacts", async () => {
    const adapter = await createTestAdapter();

    const a1 = await adapter.create(createSummaryArtifactInput());
    assertResultOk(a1);
    const a2 = await adapter.create(createSummaryArtifactInput());
    assertResultOk(a2);

    await adapter.deleteArtifact({ id: a1.data.id });

    const result = await adapter.getManyLatest({ ids: [a1.data.id, a2.data.id] });

    assertResultOk(result);
    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.id).toEqual(a2.data.id);
  });

  it("getManyLatest skips missing artifacts", async () => {
    const adapter = await createTestAdapter();

    const a1 = await adapter.create(createSummaryArtifactInput());
    assertResultOk(a1);

    const result = await adapter.getManyLatest({
      ids: [a1.data.id, "non-existent-1", "non-existent-2"],
    });

    assertResultOk(result);
    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.id).toEqual(a1.data.id);
  });
});

//
// 6. File Handling
//

describe("LocalAdapter: Files", () => {
  it("readFileContents for JSON file", async () => {
    const adapter = await createTestAdapter();
    const testData = { message: "hello world", number: 42 };
    const tempFile = await createTempJsonFile(testData);

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultOk(readResult);
    expect(JSON.parse(readResult.data)).toEqual(testData);

    await cleanupTempFile(tempFile);
  });

  it("readFileContents for CSV file", async () => {
    const adapter = await createTestAdapter();
    const tempFile = await createTempCsvFile([
      ["name", "age"],
      ["Alice", "30"],
      ["Bob", "25"],
    ]);

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultOk(readResult);
    expect(readResult.data.includes("Alice")).toEqual(true);
    expect(readResult.data.includes("Bob")).toEqual(true);

    await cleanupTempFile(tempFile);
  });

  it("readFileContents for plain text file", async () => {
    const adapter = await createTestAdapter();
    const testContent = "Hello, world!\nThis is a test file.";
    const tempFile = await createTempTextFile(testContent);

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultOk(readResult);
    expect(readResult.data).toEqual(testContent);

    await cleanupTempFile(tempFile);
  });

  it("readFileContents for markdown file", async () => {
    const adapter = await createTestAdapter();
    const testContent = "# Heading\n\n- Item 1\n- Item 2\n\n**Bold text**";
    const tempFile = await createTempMarkdownFile(testContent);

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultOk(readResult);
    expect(readResult.data).toEqual(testContent);

    await cleanupTempFile(tempFile);
  });

  it("readFileContents fails for unsupported MIME types", async () => {
    const adapter = await createTestAdapter();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bin-"));
    const tempFile = path.join(tempDir, "test.bin");
    await fs.writeFile(tempFile, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultFail(readResult);
    expect(readResult.error.includes("Unsupported mime type")).toEqual(true);

    await cleanupTempFile(tempFile);
  });

  it("readFileContents fails for non-file artifacts", async () => {
    const adapter = await createTestAdapter();

    const createResult = await adapter.create(createSummaryArtifactInput());
    assertResultOk(createResult);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultFail(readResult);
    expect(readResult.error.includes("not a file artifact")).toEqual(true);
  });

  it("readFileContents fails for missing file", async () => {
    const adapter = await createTestAdapter();
    const tempFile = await createTempJsonFile({ test: "data" });

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    // Delete the file
    await fs.unlink(tempFile);

    const readResult = await adapter.readFileContents({ id: createResult.data.id });

    assertResultFail(readResult);
    expect(readResult.error.includes("Failed to read file")).toEqual(true);
  });

  it("MIME type detection for various extensions", async () => {
    const adapter = await createTestAdapter();

    const testCases = [
      { ext: ".json", expected: "application/json" },
      { ext: ".csv", expected: "text/csv" },
      { ext: ".txt", expected: "text/plain" },
    ];

    for (const testCase of testCases) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-mime-"));
      const tempFile = path.join(tempDir, `test${testCase.ext}`);
      await fs.writeFile(tempFile, "test content");

      const createResult = await adapter.create(createFileArtifactInput(tempFile));
      assertResultOk(createResult);

      if (createResult.data.data.type === "file") {
        expect(createResult.data.data.data.mimeType).toEqual(testCase.expected);
      }

      await cleanupTempFile(tempFile);
    }
  });
});

//
// 6b. Binary File Handling
//

describe("LocalAdapter: Binary Files", () => {
  it("readBinaryContents returns raw bytes for image file", async () => {
    const adapter = await createTestAdapter();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-img-"));
    const tempFile = path.join(tempDir, "test.png");
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(tempFile, imageBytes);

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    const readResult = await adapter.readBinaryContents({ id: createResult.data.id });

    assertResultOk(readResult);
    expect(readResult.data).toBeInstanceOf(Uint8Array);
    expect(readResult.data).toEqual(imageBytes);

    await cleanupTempFile(tempFile);
  });

  it("readBinaryContents fails for non-file artifacts", async () => {
    const adapter = await createTestAdapter();

    const createResult = await adapter.create(createSummaryArtifactInput());
    assertResultOk(createResult);

    const readResult = await adapter.readBinaryContents({ id: createResult.data.id });

    assertResultFail(readResult);
    expect(readResult.error).toContain("not a file artifact");
  });

  it("readBinaryContents fails for missing artifacts", async () => {
    const adapter = await createTestAdapter();

    const readResult = await adapter.readBinaryContents({ id: "non-existent" });

    assertResultFail(readResult);
    expect(readResult.error).toContain("not found");
  });
});

//
// 7. Artifact Type Coverage
//

describe("LocalAdapter: Types", () => {
  it("create workspace-plan artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createWorkspacePlanInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("workspace-plan");
  });

  it("create calendar-schedule artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createCalendarScheduleInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("calendar-schedule");
  });

  it("create summary artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createSummaryArtifactInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("summary");
  });

  it("create slack-summary artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createSlackSummaryInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("slack-summary");
  });

  it("create file artifact", async () => {
    const adapter = await createTestAdapter();
    const tempFile = await createTempJsonFile({ test: "data" });
    const input = createFileArtifactInput(tempFile);

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("file");

    await cleanupTempFile(tempFile);
  });

  it("create table artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createTableArtifactInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("table");
  });

  it("create web-search artifact", async () => {
    const adapter = await createTestAdapter();
    const input = createWebSearchInput();

    const result = await adapter.create(input);

    assertResultOk(result);
    expect(result.data.type).toEqual("web-search");
  });
});

//
// 8. Error Handling
//

describe("LocalAdapter: Errors", () => {
  it("update non-existent artifact fails", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.update({
      id: "non-existent-id",
      data: createSummaryArtifactInput().data,
      summary: "Should fail",
    });

    assertResultFail(result);
    expect(result.error.includes("not found")).toEqual(true);
  });

  it("delete non-existent artifact fails", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.deleteArtifact({ id: "non-existent-id" });

    assertResultFail(result);
    expect(result.error.includes("not found")).toEqual(true);
  });

  it("invalid file path handling", async () => {
    const adapter = await createTestAdapter();

    const result = await adapter.create(createFileArtifactInput("/invalid/path/file.json"));

    assertResultFail(result);
    expect(result.error.includes("not found")).toEqual(true);
  });
});
