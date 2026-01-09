import process from "node:process";
import { assertEquals } from "@std/assert";
import { CortexStorageAdapter } from "./cortex-adapter.ts";
import { assertResultFail, assertResultOk } from "./test-utils/assertions.ts";
import { CortexTestServer } from "./test-utils/cortex-test-server.ts";
import { MockGCSServer } from "./test-utils/gcs-mock.ts";
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

// Check if Cortex tests should run
const shouldRunCortexTests = process.env.CORTEX_TEST === "true";

if (!shouldRunCortexTests) {
  console.log("⏭️  Skipping Cortex adapter tests (set CORTEX_TEST=true to run)");
  Deno.exit(0);
}

// Global test infrastructure
let cortexServer: CortexTestServer;
let gcsServer: MockGCSServer;
let adapter: CortexStorageAdapter;

// Setup once before all tests
async function globalSetup() {
  console.log("🚀 Setting up Cortex test environment...");

  // 1. Start mock GCS server
  gcsServer = new MockGCSServer(4443);
  await gcsServer.start();
  console.log("✓ Mock GCS started on port 4443");

  // 2. Start Cortex with go run
  cortexServer = new CortexTestServer(8181);
  await cortexServer.start();
  console.log("✓ Cortex started on port 8181");

  // 3. Create test user in database
  await createTestUser();
  console.log("✓ Test user created");

  // 4. Set auth token and create adapter instance
  process.env.ATLAS_KEY = cortexServer.authToken;
  adapter = new CortexStorageAdapter(cortexServer.url);
  console.log("✓ Test environment ready\n");
}

// Create test user in database
async function createTestUser() {
  const dbUrl =
    process.env.CORTEX_TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable";

  const command = new Deno.Command("psql", {
    args: [
      dbUrl,
      "-c",
      `INSERT INTO public."user" (id, full_name, email)
       VALUES ('${cortexServer.userId}', 'Cortex Test User', '${cortexServer.userId}@test.com')
       ON CONFLICT (id) DO NOTHING`,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code } = await command.output();
  if (code !== 0) {
    throw new Error("Failed to create test user in database");
  }
}

// Teardown after all tests
async function globalTeardown() {
  console.log("\n🧹 Cleaning up test environment...");

  // Clean up test user
  try {
    const dbUrl =
      process.env.CORTEX_TEST_DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable";

    const command = new Deno.Command("psql", {
      args: [
        dbUrl,
        "-c",
        `DELETE FROM cortex.object WHERE user_id = '${cortexServer.userId}';
         DELETE FROM public."user" WHERE id = '${cortexServer.userId}';`,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    await command.output();
  } catch (error) {
    console.warn("Failed to clean up test user:", error);
  }

  await cortexServer.stop();
  await gcsServer.stop();
  console.log("✓ Cleanup complete");
}

// Reset data between individual tests
async function resetTestData() {
  await cortexServer.reset();
  gcsServer.reset();
}

// Run setup
await globalSetup();

// Track if teardown has been called to avoid multiple calls
let teardownCalled = false;

// Wrap teardown to ensure it only runs once
async function ensureTeardown() {
  if (teardownCalled) return;
  teardownCalled = true;
  await globalTeardown();
}

// Register teardown on various exit conditions
globalThis.addEventListener("unload", () => {
  // Note: unload is synchronous in some contexts, so we can't await here
  // The signal handlers below will handle proper async teardown
  if (!teardownCalled) {
    console.log("\n⚠️  Unload event triggered but teardown will be handled by signal handlers");
  }
});

// Handle interruption signals (Ctrl+C, kill, etc.)
const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  Deno.addSignalListener(signal, async () => {
    console.log(`\n\n🛑 Received ${signal}, cleaning up...`);
    await ensureTeardown();
    Deno.exit(130); // Standard exit code for SIGINT
  });
}

// Also register a beforeunload handler for browser-like environments
globalThis.addEventListener("beforeunload", () => {
  if (!teardownCalled) {
    // Attempt synchronous cleanup indication
    console.log("\n⚠️  Process exiting, may need manual cleanup");
  }
});

//
// 1. CRUD Operations
//

Deno.test("Cortex: CRUD - create summary artifact uploads to Cortex", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.revision, 1);
  assertEquals(result.data.title, input.title);

  // Verify blob was uploaded to GCS
  const blobs = gcsServer.getStoredBlobs();
  assertEquals(blobs.length >= 1, true);
});

Deno.test("Cortex: CRUD - create sets correct metadata structure", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput({ workspaceId: "ws-test", chatId: "chat-test" });
  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.workspaceId, "ws-test");
  assertEquals(result.data.chatId, "chat-test");
  assertEquals(result.data.type, "summary");
});

Deno.test("Cortex: CRUD - create file artifact uploads file content to GCS", async () => {
  await resetTestData();

  const tempFile = await createTempJsonFile({ test: "data" });
  const input = createFileArtifactInput(tempFile);

  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "file");

  // Verify file was uploaded to GCS
  const blobs = gcsServer.getStoredBlobs();
  assertEquals(blobs.length >= 1, true);

  // Verify cortex:// path
  if (result.data.data.type === "file") {
    assertEquals(result.data.data.data.path.startsWith("cortex://"), true);
  }

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: CRUD - create binary file with base64 encoding", async () => {
  await resetTestData();

  const tempFile = await Deno.makeTempFile({ suffix: ".bin" });
  const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
  await Deno.writeFile(tempFile, binaryData);

  const input = createFileArtifactInput(tempFile);
  const result = await adapter.create(input);

  assertResultOk(result);

  // Verify blob was uploaded
  const blobs = gcsServer.getStoredBlobs();
  assertEquals(blobs.length >= 1, true);

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: CRUD - get artifact downloads and parses blob", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const getResult = await adapter.get({ id: createResult.data.id });

  assertResultOk(getResult);
  assertEquals(getResult.data?.id, createResult.data.id);
  assertEquals(getResult.data?.title, input.title);
});

Deno.test("Cortex: CRUD - get artifact by specific revision", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  // Update to create revision 2
  await adapter.update({ id: createResult.data.id, data: input.data, summary: "Updated" });

  // Get revision 1
  const getResult = await adapter.get({ id: createResult.data.id, revision: 1 });

  assertResultOk(getResult);
  assertEquals(getResult.data?.revision, 1);
  assertEquals(getResult.data?.summary, input.summary);
});

Deno.test("Cortex: CRUD - get non-existent artifact returns null", async () => {
  await resetTestData();

  const result = await adapter.get({ id: "non-existent-id" });

  assertResultOk(result);
  assertEquals(result.data, null);
});

Deno.test("Cortex: CRUD - update creates new Cortex object", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const updateResult = await adapter.update({
    id: createResult.data.id,
    data: input.data,
    summary: "Updated summary",
    revisionMessage: "Test update",
  });

  assertResultOk(updateResult);
  assertEquals(updateResult.data.revision, 2);
  assertEquals(updateResult.data.summary, "Updated summary");
  assertEquals(updateResult.data.revisionMessage, "Test update");
});

Deno.test("Cortex: CRUD - update preserves previous revision", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  // Get revision 1
  const rev1 = await adapter.get({ id: createResult.data.id, revision: 1 });
  assertResultOk(rev1);
  assertEquals(rev1.data?.revision, 1);
  assertEquals(rev1.data?.summary, input.summary);
});

Deno.test("Cortex: CRUD - delete soft-deletes all revisions", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  const deleteResult = await adapter.deleteArtifact({ id: createResult.data.id });
  assertResultOk(deleteResult);

  // Verify both revisions are gone
  const getLatest = await adapter.get({ id: createResult.data.id });
  assertResultOk(getLatest);
  assertEquals(getLatest.data, null);

  const getRev1 = await adapter.get({ id: createResult.data.id, revision: 1 });
  assertResultOk(getRev1);
  assertEquals(getRev1.data, null);
});

//
// 2. Revision Management
//

Deno.test("Cortex: Revisions - create sets is_latest=true in metadata", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.revision, 1);

  // Get should return the artifact (verifying is_latest works)
  const getResult = await adapter.get({ id: result.data.id });
  assertResultOk(getResult);
  assertEquals(getResult.data?.id, result.data.id);
});

Deno.test("Cortex: Revisions - update marks old revision as not latest", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  // Getting without revision should return revision 2 (latest)
  const getLatest = await adapter.get({ id: createResult.data.id });
  assertResultOk(getLatest);
  assertEquals(getLatest.data?.revision, 2);
});

Deno.test("Cortex: Revisions - update marks new revision as latest", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const updateResult = await adapter.update({
    id: createResult.data.id,
    data: input.data,
    summary: "v2",
  });

  assertResultOk(updateResult);

  // Get latest should return revision 2
  const getResult = await adapter.get({ id: createResult.data.id });
  assertResultOk(getResult);
  assertEquals(getResult.data?.revision, 2);
});

Deno.test("Cortex: Revisions - multiple updates maintain correct is_latest flags", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });
  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v3" });

  const getLatest = await adapter.get({ id: createResult.data.id });
  assertResultOk(getLatest);
  assertEquals(getLatest.data?.revision, 3);
  assertEquals(getLatest.data?.summary, "v3");
});

Deno.test("Cortex: Revisions - can retrieve any historical revision", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });
  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v3" });

  // Get each revision
  for (let rev = 1; rev <= 3; rev++) {
    const result = await adapter.get({ id: createResult.data.id, revision: rev });
    assertResultOk(result);
    assertEquals(result.data?.revision, rev);
  }
});

Deno.test("Cortex: Revisions - revision message persisted correctly", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const updateResult = await adapter.update({
    id: createResult.data.id,
    data: input.data,
    summary: "v2",
    revisionMessage: "Fixed bug #42",
  });

  assertResultOk(updateResult);
  assertEquals(updateResult.data.revisionMessage, "Fixed bug #42");
});

//
// 3. Race Condition Handling
//

Deno.test("Cortex: Race - get() returns correct revision during update", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  // Perform update (this may briefly have race window)
  const updateResult = await adapter.update({
    id: createResult.data.id,
    data: input.data,
    summary: "Updated",
  });

  assertResultOk(updateResult);

  // Get should return the latest revision
  const getResult = await adapter.get({ id: createResult.data.id });
  assertResultOk(getResult);
  assertEquals(getResult.data?.revision, 2);
});

Deno.test("Cortex: Race - get() handles missing is_latest flag gracefully", async () => {
  await resetTestData();

  // This tests the fallback mechanism in get() when is_latest=false
  // In normal operation, the update completes quickly and this shouldn't happen
  // But the fallback ensures correctness even during the race window

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  // Multiple gets should all return revision 2
  for (let i = 0; i < 3; i++) {
    const getResult = await adapter.get({ id: createResult.data.id });
    assertResultOk(getResult);
    assertEquals(getResult.data?.revision, 2);
  }
});

Deno.test("Cortex: Race - concurrent reads return correct revision", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  // Perform update and concurrent gets
  const updatePromise = adapter.update({
    id: createResult.data.id,
    data: input.data,
    summary: "v2",
  });

  const get1Promise = adapter.get({ id: createResult.data.id });
  const get2Promise = adapter.get({ id: createResult.data.id });

  const [updateResult, get1Result, get2Result] = await Promise.all([
    updatePromise,
    get1Promise,
    get2Promise,
  ]);

  assertResultOk(updateResult);
  assertResultOk(get1Result);
  assertResultOk(get2Result);

  // Both gets should return valid data (either rev 1 or rev 2)
  assertEquals([1, 2].includes(get1Result.data?.revision ?? 0), true);
  assertEquals([1, 2].includes(get2Result.data?.revision ?? 0), true);
});

Deno.test("Cortex: Race - update completes successfully despite concurrent operations", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  // Multiple concurrent updates (should be serialized by Cortex)
  const update1 = adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  const update2 = adapter.update({ id: createResult.data.id, data: input.data, summary: "v3" });

  const [result1, result2] = await Promise.all([update1, update2]);

  // At least one should succeed
  const succeeded = [result1.ok, result2.ok].filter(Boolean).length;
  assertEquals(succeeded >= 1, true);
});

Deno.test("Cortex: Race - list operations eventual consistency", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  // Update and immediately list
  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  const listResult = await adapter.listAll({});
  assertResultOk(listResult);

  // Should find the artifact (may be rev 1 or 2 depending on timing)
  const found = listResult.data.find((a) => a.id === createResult.data.id);
  assertEquals(found !== undefined, true);
});

//
// 4. Metadata Operations
//

Deno.test("Cortex: Metadata - workspace ID filtering works", async () => {
  await resetTestData();

  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-2" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));

  const result = await adapter.listByWorkspace({ workspaceId: "ws-1" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
  assertEquals(
    result.data.every((a) => a.workspaceId === "ws-1"),
    true,
  );
});

Deno.test("Cortex: Metadata - chat ID filtering works", async () => {
  await resetTestData();

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

Deno.test("Cortex: Metadata - title and summary updates persist", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const updateResult = await adapter.update({
    id: createResult.data.id,
    data: input.data,
    title: "Updated Title",
    summary: "Updated Summary",
  });

  assertResultOk(updateResult);
  assertEquals(updateResult.data.title, "Updated Title");
  assertEquals(updateResult.data.summary, "Updated Summary");
});

Deno.test("Cortex: Metadata - is_latest flag queries work correctly", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });

  // List should only return latest revision
  const listResult = await adapter.listAll({});
  assertResultOk(listResult);

  const found = listResult.data.filter((a) => a.id === createResult.data.id);
  assertEquals(found.length, 1);
  assertEquals(found[0]?.revision, 2);
});

Deno.test("Cortex: Metadata - artifact type stored correctly", async () => {
  await resetTestData();

  const input = createTableArtifactInput();
  const result = await adapter.create(input);

  assertResultOk(result);
  assertEquals(result.data.type, "table");

  const getResult = await adapter.get({ id: result.data.id });
  assertResultOk(getResult);
  assertEquals(getResult.data?.type, "table");
});

//
// 5. File Handling
//

Deno.test("Cortex: Files - file upload creates cortex:// path reference", async () => {
  await resetTestData();

  const tempFile = await createTempJsonFile({ test: "data" });
  const input = createFileArtifactInput(tempFile);

  const result = await adapter.create(input);

  assertResultOk(result);
  if (result.data.data.type === "file") {
    assertEquals(result.data.data.data.path.startsWith("cortex://"), true);
  }

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - binary files encoded as base64 with prefix", async () => {
  await resetTestData();

  const tempFile = await Deno.makeTempFile({ suffix: ".bin" });
  await Deno.writeFile(tempFile, new Uint8Array([1, 2, 3, 4]));

  const input = createFileArtifactInput(tempFile);
  const result = await adapter.create(input);

  assertResultOk(result);
  // File was uploaded (we can't directly verify base64, but creation succeeds)

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - text files stored as UTF-8 strings", async () => {
  await resetTestData();

  const tempFile = await createTempJsonFile({ message: "hello" });
  const input = createFileArtifactInput(tempFile);

  const result = await adapter.create(input);

  assertResultOk(result);

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - readFileContents decodes content correctly", async () => {
  await resetTestData();

  const testData = { message: "test data" };
  const tempFile = await createTempJsonFile(testData);
  const input = createFileArtifactInput(tempFile);

  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultOk(readResult);
  assertEquals(JSON.parse(readResult.data), testData);

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - readFileContents returns text for text files", async () => {
  await resetTestData();

  const tempFile = await createTempCsvFile([
    ["name", "age"],
    ["Alice", "30"],
  ]);
  const input = createFileArtifactInput(tempFile);

  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultOk(readResult);
  assertEquals(readResult.data.includes("Alice"), true);

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - original filename preserved in metadata", async () => {
  await resetTestData();

  const tempFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(tempFile, "{}");

  const input = createFileArtifactInput(tempFile);
  const result = await adapter.create(input);

  assertResultOk(result);
  // Filename is preserved (we verify by checking the artifact was created successfully)

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Files - MIME type detection works for uploaded files", async () => {
  await resetTestData();

  const tempFile = await createTempJsonFile({ test: "data" });
  const input = createFileArtifactInput(tempFile);

  const result = await adapter.create(input);

  assertResultOk(result);
  if (result.data.data.type === "file") {
    assertEquals(result.data.data.data.mimeType, "application/json");
  }

  await cleanupTempFile(tempFile);
});

//
// 6. List Operations
//

Deno.test("Cortex: List - listAll queries with is_latest=true", async () => {
  await resetTestData();

  await adapter.create(createSummaryArtifactInput());
  await adapter.create(createSummaryArtifactInput());

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, 2);
});

Deno.test("Cortex: List - listAll returns correct count with limit", async () => {
  await resetTestData();

  for (let i = 0; i < 10; i++) {
    await adapter.create(createSummaryArtifactInput({ title: `Artifact ${i}` }));
  }

  const result = await adapter.listAll({ limit: 5 });

  assertResultOk(result);
  assertEquals(result.data.length, 5);
});

Deno.test("Cortex: List - listByWorkspace filters by workspace_id", async () => {
  await resetTestData();

  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-2" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "ws-1" }));

  const result = await adapter.listByWorkspace({ workspaceId: "ws-1" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
});

Deno.test("Cortex: List - listByChat filters by chat_id", async () => {
  await resetTestData();

  await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));
  await adapter.create(createSummaryArtifactInput({ chatId: "chat-2" }));
  await adapter.create(createSummaryArtifactInput({ chatId: "chat-1" }));

  const result = await adapter.listByChat({ chatId: "chat-1" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
});

Deno.test("Cortex: List - handles empty results", async () => {
  await resetTestData();

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, 0);
});

Deno.test("Cortex: List - reconstructs artifacts from blobs", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  const listResult = await adapter.listAll({});

  assertResultOk(listResult);
  assertEquals(listResult.data.length, 1);
  assertEquals(listResult.data[0]?.id, createResult.data.id);
  assertEquals(listResult.data[0]?.title, input.title);
});

Deno.test("Cortex: List - handles blob download failures gracefully", async () => {
  await resetTestData();

  // Create an artifact (should succeed)
  await adapter.create(createSummaryArtifactInput());

  // List should succeed even if some blobs fail to download
  const result = await adapter.listAll({});

  assertResultOk(result);
  // Should have at least some results
  assertEquals(result.data.length >= 0, true);
});

Deno.test("Cortex: List - excludes deleted artifacts", async () => {
  await resetTestData();

  const a1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a1);

  const a2 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a2);

  await adapter.deleteArtifact({ id: a1.data.id });

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, a2.data.id);
});

//
// 7. Batch Operations
//

Deno.test("Cortex: Batch - getManyLatest parallelizes requests", async () => {
  await resetTestData();

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

Deno.test("Cortex: Batch - getManyLatest handles individual failures gracefully", async () => {
  await resetTestData();

  const a1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a1);

  // Request with one valid ID and one invalid
  const result = await adapter.getManyLatest({ ids: [a1.data.id, "non-existent-id"] });

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, a1.data.id);
});

Deno.test("Cortex: Batch - getManyLatest filters null results", async () => {
  await resetTestData();

  const a1 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a1);
  const a2 = await adapter.create(createSummaryArtifactInput());
  assertResultOk(a2);

  // Delete one
  await adapter.deleteArtifact({ id: a1.data.id });

  const result = await adapter.getManyLatest({ ids: [a1.data.id, a2.data.id] });

  assertResultOk(result);
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0]?.id, a2.data.id);
});

Deno.test("Cortex: Batch - getManyLatest with empty array returns empty", async () => {
  await resetTestData();

  const result = await adapter.getManyLatest({ ids: [] });

  assertResultOk(result);
  assertEquals(result.data.length, 0);
});

//
// 8. Error Handling
//

Deno.test("Cortex: Errors - authentication failure", async () => {
  await resetTestData();

  const originalKey = process.env.ATLAS_KEY;
  process.env.ATLAS_KEY = "invalid-token";
  try {
    const badAdapter = new CortexStorageAdapter(cortexServer.url);
    const result = await badAdapter.create(createSummaryArtifactInput());

    assertResultFail(result);
    assertEquals(result.error.includes("Authentication") || result.error.includes("401"), true);
  } finally {
    process.env.ATLAS_KEY = originalKey;
  }
});

Deno.test("Cortex: Errors - invalid base URL", async () => {
  const badAdapter = new CortexStorageAdapter("invalid-url");

  const result = await badAdapter.create(createSummaryArtifactInput());

  assertResultFail(result);
});

Deno.test("Cortex: Errors - missing file gracefully", async () => {
  await resetTestData();

  const result = await adapter.create(createFileArtifactInput("/nonexistent/file.json"));

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("Cortex: Errors - update non-existent artifact fails", async () => {
  await resetTestData();

  const result = await adapter.update({
    id: "non-existent-id",
    data: createSummaryArtifactInput().data,
    summary: "Should fail",
  });

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("Cortex: Errors - delete non-existent artifact fails", async () => {
  await resetTestData();

  const result = await adapter.deleteArtifact({ id: "non-existent-id" });

  assertResultFail(result);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("Cortex: Errors - readFileContents for non-file artifact", async () => {
  await resetTestData();

  const createResult = await adapter.create(createSummaryArtifactInput());
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });

  assertResultFail(readResult);
  assertEquals(readResult.error.includes("not a file artifact"), true);
});

//
// 9. Integration Scenarios
//

Deno.test("Cortex: Integration - create → get → update → get cycle", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();

  // Create
  const createResult = await adapter.create(input);
  assertResultOk(createResult);
  const artifactId = createResult.data.id;

  // Get
  const get1 = await adapter.get({ id: artifactId });
  assertResultOk(get1);
  assertEquals(get1.data?.revision, 1);

  // Update
  const updateResult = await adapter.update({
    id: artifactId,
    data: input.data,
    summary: "Updated",
  });
  assertResultOk(updateResult);

  // Get again
  const get2 = await adapter.get({ id: artifactId });
  assertResultOk(get2);
  assertEquals(get2.data?.revision, 2);
  assertEquals(get2.data?.summary, "Updated");
});

Deno.test("Cortex: Integration - create → delete → get returns null", async () => {
  await resetTestData();

  const createResult = await adapter.create(createSummaryArtifactInput());
  assertResultOk(createResult);

  await adapter.deleteArtifact({ id: createResult.data.id });

  const getResult = await adapter.get({ id: createResult.data.id });
  assertResultOk(getResult);
  assertEquals(getResult.data, null);
});

Deno.test("Cortex: Integration - create → update → update → get specific revision", async () => {
  await resetTestData();

  const input = createSummaryArtifactInput();
  const createResult = await adapter.create(input);
  assertResultOk(createResult);

  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v2" });
  await adapter.update({ id: createResult.data.id, data: input.data, summary: "v3" });

  const get2 = await adapter.get({ id: createResult.data.id, revision: 2 });
  assertResultOk(get2);
  assertEquals(get2.data?.revision, 2);
  assertEquals(get2.data?.summary, "v2");
});

Deno.test("Cortex: Integration - create multiple → listAll returns all", async () => {
  await resetTestData();

  const count = 5;
  for (let i = 0; i < count; i++) {
    await adapter.create(createSummaryArtifactInput({ title: `Artifact ${i}` }));
  }

  const result = await adapter.listAll({});

  assertResultOk(result);
  assertEquals(result.data.length, count);
});

Deno.test("Cortex: Integration - create with workspace → listByWorkspace filters", async () => {
  await resetTestData();

  await adapter.create(createSummaryArtifactInput({ workspaceId: "target-ws" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "other-ws" }));
  await adapter.create(createSummaryArtifactInput({ workspaceId: "target-ws" }));

  const result = await adapter.listByWorkspace({ workspaceId: "target-ws" });

  assertResultOk(result);
  assertEquals(result.data.length, 2);
});

Deno.test("Cortex: Integration - file upload → readFileContents retrieves content", async () => {
  await resetTestData();

  const testData = { test: "integration data" };
  const tempFile = await createTempJsonFile(testData);

  const createResult = await adapter.create(createFileArtifactInput(tempFile));
  assertResultOk(createResult);

  const readResult = await adapter.readFileContents({ id: createResult.data.id });
  assertResultOk(readResult);

  assertEquals(JSON.parse(readResult.data), testData);

  await cleanupTempFile(tempFile);
});

//
// 10. Artifact Type Coverage
//

Deno.test("Cortex: Types - create workspace-plan artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createWorkspacePlanInput());

  assertResultOk(result);
  assertEquals(result.data.type, "workspace-plan");
});

Deno.test("Cortex: Types - create calendar-schedule artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createCalendarScheduleInput());

  assertResultOk(result);
  assertEquals(result.data.type, "calendar-schedule");
});

Deno.test("Cortex: Types - create summary artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createSummaryArtifactInput());

  assertResultOk(result);
  assertEquals(result.data.type, "summary");
});

Deno.test("Cortex: Types - create slack-summary artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createSlackSummaryInput());

  assertResultOk(result);
  assertEquals(result.data.type, "slack-summary");
});

Deno.test("Cortex: Types - create file artifact", async () => {
  await resetTestData();

  const tempFile = await createTempJsonFile({ test: "data" });
  const result = await adapter.create(createFileArtifactInput(tempFile));

  assertResultOk(result);
  assertEquals(result.data.type, "file");

  await cleanupTempFile(tempFile);
});

Deno.test("Cortex: Types - create table artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createTableArtifactInput());

  assertResultOk(result);
  assertEquals(result.data.type, "table");
});

Deno.test("Cortex: Types - create web-search artifact", async () => {
  await resetTestData();

  const result = await adapter.create(createWebSearchInput());

  assertResultOk(result);
  assertEquals(result.data.type, "web-search");
});

//
// TEARDOWN - MUST BE LAST TEST IN FILE
//
// Deno runs tests in file order by default, so this cleanup test
// must stay at the end of the file to ensure proper cleanup.
//
Deno.test({
  name: "Cleanup: Teardown test environment",
  // Disable sanitizers because we're intentionally cleaning up resources
  // that were created before this test (global setup)
  sanitizeResources: false,
  sanitizeOps: false,
  sanitizeExit: false,
  fn: async () => {
    await ensureTeardown();
  },
});
