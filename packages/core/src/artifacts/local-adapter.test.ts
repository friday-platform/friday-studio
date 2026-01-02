import { assertEquals } from "@std/assert";
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
  createWebSearchInput,
  createWorkspacePlanInput,
} from "./test-utils/shared-fixtures.ts";

// Helper to create a unique temp KV database for each test
async function createTestAdapter(): Promise<LocalStorageAdapter> {
  const tempPath = await Deno.makeTempFile({ suffix: ".db" });
  return new LocalStorageAdapter(tempPath);
}

//
// 1. CRUD Operations
//

Deno.test("LocalAdapter: CRUD - create summary artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertArtifactEqual(result.data, {
    type: "summary",
    revision: 1,
    title: input.title,
    summary: input.summary,
  });
  assertEquals(result.data.id.length, 36); // UUID
});

Deno.test("LocalAdapter: CRUD - create file artifact with MIME type detection", async () => {
  const adapter = await createTestAdapter();
  const tempFile = await createTempJsonFile({ test: "data" });

  const input = createFileArtifactInput(tempFile);
  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "file");
  assertEquals(result.data.revision, 1);

  if (result.data.data.type === "file") {
    assertEquals(result.data.data.data.mimeType, "application/json");
    assertEquals(result.data.data.data.path, tempFile);
  }

  await cleanupTempFile(tempFile);
});

Deno.test("LocalAdapter: CRUD - create file artifact fails when file doesn't exist", async () => {
  const adapter = await createTestAdapter();
  const input = createFileArtifactInput("/nonexistent/file.json");

  const result = await adapter.create(input);

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("LocalAdapter: CRUD - get artifact by ID (latest revision)", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  const getResult = await adapter.get({ id: artifactId });

  assertResultOk(getResult);
  assertEquals(getResult.data?.id, artifactId);
  assertEquals(getResult.data?.revision, 1);
});

Deno.test("LocalAdapter: CRUD - get artifact by specific revision", async () => {
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
  assertEquals(getResult.data?.revision, 1);
  assertEquals(getResult.data?.summary, input.summary);
});

Deno.test("LocalAdapter: CRUD - get deleted artifact returns null", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  await adapter.deleteArtifact({ id: artifactId });

  const getResult = await adapter.get({ id: artifactId });

  assertResultOk(getResult);
  assertEquals(getResult.data, null);
});

Deno.test("LocalAdapter: CRUD - get non-existent artifact returns null", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.get({ id: "non-existent-id" });

  assertResultOk(result);
  assertEquals(result.data, null);
});

Deno.test("LocalAdapter: CRUD - update creates new revision", async () => {
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
  assertEquals(updateResult.data.revision, 2);
  assertEquals(updateResult.data.summary, "Updated summary");
  assertEquals(updateResult.data.revisionMessage, "Test update");
});

//
// 2. Revision Management
//

Deno.test("LocalAdapter: Revisions - create starts at revision 1", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.revision, 1);
});

Deno.test("LocalAdapter: Revisions - update increments revision sequentially", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  const update1 = await adapter.update({ id: artifactId, data: input.data, summary: "Update 1" });
  assertResultOk(update1);
  assertEquals(update1.data.revision, 2);

  const update2 = await adapter.update({ id: artifactId, data: input.data, summary: "Update 2" });
  assertResultOk(update2);
  assertEquals(update2.data.revision, 3);
});

Deno.test("LocalAdapter: Revisions - multiple updates create distinct revisions", async () => {
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

  assertEquals(rev1.data?.summary, input.summary);
  assertEquals(rev2.data?.summary, "v2");
  assertEquals(rev3.data?.summary, "v3");
});

Deno.test("LocalAdapter: Revisions - can retrieve any historical revision", async () => {
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
    assertEquals(result.data?.revision, rev);
  }
});

Deno.test("LocalAdapter: Revisions - latest revision pointer updates correctly", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  // Get latest (should be rev 1)
  const latest1 = await adapter.get({ id: artifactId });
  assertResultOk(latest1);
  assertEquals(latest1.data?.revision, 1);

  // Update
  await adapter.update({ id: artifactId, data: input.data, summary: "v2" });

  // Get latest (should be rev 2)
  const latest2 = await adapter.get({ id: artifactId });
  assertResultOk(latest2);
  assertEquals(latest2.data?.revision, 2);
});

Deno.test("LocalAdapter: Revisions - revision message is stored and retrievable", async () => {
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
  assertEquals(updateResult.data.revisionMessage, "Fixed bug #123");
});

//
// 3. Soft Delete
//

Deno.test("LocalAdapter: Delete - marks artifact as deleted", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  const deleteResult = await adapter.deleteArtifact({ id: artifactId });

  assertResultOk(deleteResult);
});

Deno.test("LocalAdapter: Delete - preserves all revision data", async () => {
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
  assertEquals(getResult.data, null);
});

Deno.test("LocalAdapter: Delete - get after delete returns null", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  await adapter.deleteArtifact({ id: artifactId });

  const getResult = await adapter.get({ id: artifactId });
  assertResultOk(getResult);
  assertEquals(getResult.data, null);
});

Deno.test("LocalAdapter: Delete - update deleted artifact fails", async () => {
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
  assertEquals(updateResult.error.includes("deleted"), true);
});

//
// 4. List Operations
//

Deno.test("LocalAdapter: List - listAll returns latest revisions only", async () => {
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

  assertEquals(listResult.data.length, 2);

  // Find artifact1 in list and verify it's revision 2
  const a1 = listResult.data.find((a) => a.id === id1);
  assertEquals(a1?.revision, 2);
});

Deno.test("LocalAdapter: List - listByWorkspace filters correctly", async () => {
  const adapter = await createTestAdapter();

  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1", title: "WS1 Artifact" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-2", title: "WS2 Artifact" }));
  await adapter.create(
    createSummaryArtifactInput({ workspaceId: "ws-1", title: "WS1 Artifact 2" }),
  );

  const result = await adapter.listByWorkspace({ workspaceId: "ws-1" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
  assertEquals(
    result.data.every((a) => a.workspaceId === "ws-1"),
    true,
  );
});

Deno.test("LocalAdapter: List - listByChat filters correctly", async () => {
  const adapter = await createTestAdapter();

  await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));
  await adapter.create(createSummaryArtifactInput({ chatId: "chat-2" }));
  await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));

  const result = await adapter.listByChat({ chatId: "chat-1" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
  assertEquals(
    result.data.every((a) => a.chatId === "chat-1"),
    true,
  );
});

Deno.test("LocalAdapter: List - respects limit parameter", async () => {
  const adapter = await createTestAdapter();

  for (let i = 0; i < 10; i++) {
    await adapter.create(createSummaryArtifactInput({ title: `Artifact ${i}` }));
  }

  const result = await adapter.listAll({ limit: 5 });

  assertResultOk(result);
  assertEquals(result.data.length, 5);
});

Deno.test("LocalAdapter: List - excludes deleted artifacts", async () => {
  const adapter = await createTestAdapter();

  const artifact1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(artifact1);

  const artifact2 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(artifact2);

  await adapter.deleteArtifact({ id: artifact1.data.id });

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, artifact2.data.id);
});

Deno.test("LocalAdapter: List - handles empty results", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, 0);
});

//
// 5. Batch Operations
//

Deno.test("LocalAdapter: Batch - getManyLatest with empty array returns empty", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.getManyLatest({ ids: [] });

  assertResultOk(result);
  assertEquals(result.data.length, 0);
});

Deno.test("LocalAdapter: Batch - getManyLatest with valid IDs", async () => {
  const adapter = await createTestAdapter();

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const result = await adapter.create(createSummaryArtifactInput({ title: `A${i}` }));
    assertResultOk(result);
    ids.push(result.data.id);
  }

  const batchResult = await adapter.getManyLatest({ ids });

  assertResultOk(batchResult);
  assertEquals(batchResult.data.length, 3);
});

Deno.test("LocalAdapter: Batch - getManyLatest skips deleted artifacts", async () => {
  const adapter = await createTestAdapter();

  const a1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a1);
  const a2 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a2);

  await adapter.deleteArtifact({ id: a1.data.id });

  const result = await adapter.getManyLatest({ ids: [a1.data.id, a2.data.id] });

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, a2.data.id);
});

Deno.test("LocalAdapter: Batch - getManyLatest skips missing artifacts", async () => {
  const adapter = await createTestAdapter();

  const a1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a1);

  const result = await adapter.getManyLatest({
    ids: [a1.data.id, "non-existent-1", "non-existent-2"],
  });

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, a1.data.id);
});

//
// 6. File Handling
//

Deno.test("LocalAdapter: Files - readFileContents for JSON file", async () => {
  const adapter = await createTestAdapter();
  const testData = { message: "hello world", number: 42 };
  const tempFile = await createTempJsonFile(testData);

  const createResult = await adapter.create(createFileArtifactInput(tempFile));
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultOk(readResult);
  assertEquals(JSON.parse(readResult.data), testData);

  await cleanupTempFile(tempFile);
});

Deno.test("LocalAdapter: Files - readFileContents for CSV file", async () => {
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
  assertEquals(readResult.data.includes("Alice"), true);
  assertEquals(readResult.data.includes("Bob"), true);

  await cleanupTempFile(tempFile);
});

Deno.test("LocalAdapter: Files - readFileContents fails for unsupported MIME types", async () => {
  const adapter = await createTestAdapter();
  const tempFile = await Deno.makeTempFile({ suffix: ".bin" });
  await Deno.writeFile(tempFile, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  const createResult = await adapter.create(createFileArtifactInput(tempFile));
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultFail(readResult);
  assertEquals(readResult.error.includes("Unsupported mime type"), true);

  await cleanupTempFile(tempFile);
});

Deno.test("LocalAdapter: Files - readFileContents fails for non-file artifacts", async () => {
  const adapter = await createTestAdapter();

  const createResult = await adapter.create(createSummaryArtifactInput());
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultFail(readResult);
  assertEquals(readResult.error.includes("not a file artifact"), true);
});

Deno.test("LocalAdapter: Files - readFileContents fails for missing file", async () => {
  const adapter = await createTestAdapter();
  const tempFile = await createTempJsonFile({ test: "data" });

  const createResult = await adapter.create(createFileArtifactInput(tempFile));
  assertResultOk(createResult);

  // Delete the file
  await Deno.remove(tempFile);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultFail(readResult);
  assertEquals(readResult.error.includes("Failed to read file"), true);
});

Deno.test("LocalAdapter: Files - MIME type detection for various extensions", async () => {
  const adapter = await createTestAdapter();

  const testCases = [
    { ext: ".json", expected: "application/json" },
    { ext: ".csv", expected: "text/csv" },
    { ext: ".txt", expected: "text/plain" },
  ];

  for (const testCase of testCases) {
    const tempFile = await Deno.makeTempFile({ suffix: testCase.ext });
    await Deno.writeTextFile(tempFile, "test content");

    const createResult = await adapter.create(createFileArtifactInput(tempFile));
    assertResultOk(createResult);

    if (createResult.data.data.type === "file") {
      assertEquals(createResult.data.data.data.mimeType, testCase.expected);
    }

    await cleanupTempFile(tempFile);
  }
});

//
// 7. Artifact Type Coverage
//

Deno.test("LocalAdapter: Types - create workspace-plan artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createWorkspacePlanInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "workspace-plan");
});

Deno.test("LocalAdapter: Types - create calendar-schedule artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createCalendarScheduleInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "calendar-schedule");
});

Deno.test("LocalAdapter: Types - create summary artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createSummaryArtifactInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "summary");
});

Deno.test("LocalAdapter: Types - create slack-summary artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createSlackSummaryInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "slack-summary");
});

Deno.test("LocalAdapter: Types - create file artifact", async () => {
  const adapter = await createTestAdapter();
  const tempFile = await createTempJsonFile({ test: "data" });
  const input = createFileArtifactInput(tempFile);

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "file");

  await cleanupTempFile(tempFile);
});

Deno.test("LocalAdapter: Types - create table artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createTableArtifactInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "table");
});

Deno.test("LocalAdapter: Types - create web-search artifact", async () => {
  const adapter = await createTestAdapter();
  const input = createWebSearchInput();

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "web-search");
});

//
// 8. Error Handling
//

Deno.test("LocalAdapter: Errors - update non-existent artifact fails", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.update({
    id: "non-existent-id",
    data: createSummaryArtifactInput().data,
    summary: "Should fail",
  });

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("LocalAdapter: Errors - delete non-existent artifact fails", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.deleteArtifact({ id: "non-existent-id" });

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("LocalAdapter: Errors - invalid file path handling", async () => {
  const adapter = await createTestAdapter();

  const result = await adapter.create(createFileArtifactInput("/invalid/path/file.json"));

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});
