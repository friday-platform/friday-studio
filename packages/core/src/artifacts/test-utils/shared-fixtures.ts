import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateArtifactInput } from "../model.ts";
import type { DatabaseSchema } from "../primitives.ts";

/**
 * Create a summary artifact input for testing.
 */
export function createSummaryArtifactInput(
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: { type: "summary", version: 1, data: "Test summary content" },
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
    data: {
      type: "workspace-plan",
      version: 1,
      data: {
        workspace: { name: "test-workspace", purpose: "A test workspace for testing purposes" },
        signals: [
          {
            id: "test-signal",
            name: "Test Signal",
            title: "Triggers on demand",
            signalType: "http",
            description: "A test signal that triggers on demand",
          },
        ],
        agents: [
          {
            id: "test-agent",
            name: "Test Agent",
            description: "A test agent for testing",
            capabilities: ["web-access"],
          },
        ],
        jobs: [
          {
            id: "test-job",
            name: "Test Job",
            title: "Test Job",
            triggerSignalId: "test-signal",
            steps: [{ agentId: "test-agent", description: "Test step" }],
            behavior: "sequential",
          },
        ],
      },
    },
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
    data: {
      type: "table",
      version: 1,
      data: {
        title: "Test Table",
        headers: ["id", "name"],
        rows: [
          { id: "1", name: "Alice" },
          { id: "2", name: "Bob" },
        ],
      },
    },
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
    data: {
      type: "calendar-schedule",
      version: 1,
      data: {
        events: [
          {
            id: "event-1",
            eventName: "Test Event",
            startDate: "2025-01-01T10:00:00Z",
            endDate: "2025-01-01T11:00:00Z",
          },
        ],
        source: "test",
      },
    },
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
    data: {
      type: "slack-summary",
      version: 1,
      data: "Test slack summary content from #test-channel",
    },
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
    data: {
      type: "web-search",
      version: 1,
      data: {
        response: "# Test Web Search Results\n\nTest content here.",
        sources: [
          { siteName: "Example Site", pageTitle: "Test Result", url: "https://example.com" },
        ],
      },
    },
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

/**
 * Create a database artifact input for testing.
 * Requires a pre-created SQLite database file.
 */
export function createDatabaseArtifactInput(
  dbPath: string,
  schema: DatabaseSchema,
  overrides?: Partial<CreateArtifactInput>,
): CreateArtifactInput {
  return {
    data: {
      type: "database",
      version: 1,
      data: { path: dbPath, sourceFileName: "test-data.csv", schema },
    },
    title: "Test Database",
    summary: `${schema.rowCount} rows, ${schema.columns.length} columns`,
    ...overrides,
  };
}
