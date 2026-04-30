import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateArtifactInput } from "../model.ts";

/** Absolute path to the shared fixture file for file-type artifact tests. */
const FIXTURE_FILE = new URL("./test-fixture.txt", import.meta.url).pathname;

/**
 * Create a summary artifact input for testing.
 */
export function createSummaryArtifactInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Summary",
    summary: "A test summary artifact",
    ...overrides,
  };
}

/**
 * Create a workspace-plan artifact input for testing.
 */
export function createWorkspacePlanInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Workspace Plan",
    summary: "A test workspace plan",
    ...overrides,
  };
}

/**
 * Create a table artifact input for testing.
 */
export function createTableArtifactInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Table",
    summary: "A test table artifact",
    ...overrides,
  };
}

/**
 * Create a calendar-schedule artifact input for testing.
 */
export function createCalendarScheduleInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Calendar",
    summary: "A test calendar schedule",
    ...overrides,
  };
}

/**
 * Create a slack-summary artifact input for testing.
 */
export function createSlackSummaryInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Slack Summary",
    summary: "A test slack summary",
    ...overrides,
  };
}

/**
 * Create a web-search artifact input for testing.
 */
export function createWebSearchInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: FIXTURE_FILE } },
    title: "Test Web Search",
    summary: "A test web search result",
    ...overrides,
  };
}

/**
 * Create a file artifact input for testing.
 */
export function createFileArtifactInput(
  filePath: string,
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "file", version: 1, data: { path: filePath } },
    title: "Test File",
    summary: "A test file artifact",
    ...overrides,
  };
}

/**
 * Create a temporary JSON file with test data.
 * Caller is responsible for cleanup.
 */
export async function createTempJsonFile(data: unknown): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-test-"));
  const tempFile = join(tempDir, `${randomUUID()}.json`);
  await writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
  return tempFile;
}

/**
 * Create a temporary CSV file with test data.
 * Caller is responsible for cleanup.
 */
export async function createTempCsvFile(rows: string[][]): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-test-"));
  const tempFile = join(tempDir, `${randomUUID()}.csv`);
  const csvContent = rows.map((row) => row.join(",")).join("\n");
  await writeFile(tempFile, csvContent, "utf-8");
  return tempFile;
}

/**
 * Create a temporary text file with test data.
 * Caller is responsible for cleanup.
 */
export async function createTempTextFile(content: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-test-"));
  const tempFile = join(tempDir, `${randomUUID()}.txt`);
  await writeFile(tempFile, content, "utf-8");
  return tempFile;
}

/**
 * Create a temporary markdown file with test data.
 * Caller is responsible for cleanup.
 */
export async function createTempMarkdownFile(content: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-test-"));
  const tempFile = join(tempDir, `${randomUUID()}.md`);
  await writeFile(tempFile, content, "utf-8");
  return tempFile;
}

/**
 * Clean up a temporary file.
 */
export async function cleanupTempFile(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Ignore errors if file doesn't exist
  }
}

