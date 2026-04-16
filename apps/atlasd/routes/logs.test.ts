import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppVariables } from "../src/factory.ts";
import { LogTailResponseSchema, logsRoutes, parseLogLine } from "./logs.ts";

// --- Mock node:fs/promises ---

type FileHandle = {
  stat: () => Promise<{ size: number }>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  close: () => Promise<void>;
};

const mockFileHandle = {
  stat: vi.fn<() => Promise<{ size: number }>>(),
  read: vi.fn<
    (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number }>
  >(),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

const mockOpen = vi.fn<(path: string, flags: string) => Promise<FileHandle>>();

vi.mock("node:fs/promises", () => ({
  default: { open: (...args: unknown[]) => mockOpen(args[0] as string, args[1] as string) },
  open: (...args: unknown[]) => mockOpen(args[0] as string, args[1] as string),
}));

vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => "/mock/atlas" }));

vi.mock("@atlas/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

// --- Test helpers ---

function makeLogLine(level: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-04-15T16:00:00.000Z",
    level,
    message,
    context: { component: "test-component", ...extra },
  });
}

/** Build a JSONL buffer from an array of log lines, returning the content string. */
function buildJSONL(lines: string[]): string {
  return lines.join("\n") + "\n";
}

/** Setup mockOpen and mockFileHandle.read to serve the given content string from a virtual file. */
function setupMockFile(content: string): void {
  const buf = Buffer.from(content, "utf-8");

  mockOpen.mockResolvedValue(mockFileHandle);
  mockFileHandle.stat.mockResolvedValue({ size: buf.length });
  mockFileHandle.read.mockImplementation(
    (target: Buffer, _offset: number, length: number, position: number) => {
      const start = Math.min(position, buf.length);
      const end = Math.min(start + length, buf.length);
      const bytesRead = end - start;
      buf.copy(target, 0, start, end);
      return Promise.resolve({ bytesRead });
    },
  );
}

function createTestApp() {
  const app = new Hono<AppVariables>();
  app.route("/", logsRoutes);
  return app;
}

// --- Tests ---

describe("GET /logs/tail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reads JSONL, filters to error+fatal only, returns structured entries", async () => {
    const content = buildJSONL([
      makeLogLine("info", "Info message"),
      makeLogLine("error", "Something broke"),
      makeLogLine("fatal", "Critical failure"),
      makeLogLine("debug", "Debug noise"),
      makeLogLine("error", "Another error"),
    ]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?level_filter=error,fatal");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]?.level).toBe("error");
    expect(parsed.entries[0]?.message).toBe("Something broke");
    expect(parsed.entries[1]?.level).toBe("fatal");
    expect(parsed.entries[2]?.level).toBe("error");
  });

  test("since_offset=N skips first N bytes", async () => {
    const line1 = makeLogLine("error", "First error");
    const line2 = makeLogLine("error", "Second error");
    const content = line1 + "\n" + line2 + "\n";
    setupMockFile(content);

    // Offset past the first line (line1 + newline)
    const offset = Buffer.byteLength(line1 + "\n", "utf-8");

    const app = createTestApp();
    const res = await app.request(`/tail?since_offset=${offset}&level_filter=error`);
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.message).toBe("Second error");
  });

  test("limit=2 caps at 2 entries", async () => {
    const content = buildJSONL([
      makeLogLine("error", "Error 1"),
      makeLogLine("error", "Error 2"),
      makeLogLine("error", "Error 3"),
    ]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?limit=2&level_filter=error");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test("malformed JSONL lines are skipped gracefully (no crash)", async () => {
    const content = buildJSONL([
      makeLogLine("error", "Good line 1"),
      "this is not json {{{",
      "",
      makeLogLine("error", "Good line 2"),
      "null",
    ]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?level_filter=error");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.message).toBe("Good line 1");
    expect(parsed.entries[1]?.message).toBe("Good line 2");
  });

  test("missing log file returns empty response", async () => {
    mockOpen.mockRejectedValue(new Error("ENOENT"));

    const app = createTestApp();
    const res = await app.request("/tail");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toEqual([]);
    expect(parsed.next_offset).toBe(0);
    expect(parsed.truncated).toBe(false);
  });

  test("level_filter=warn,error includes warn-level entries", async () => {
    const content = buildJSONL([
      makeLogLine("warn", "A warning"),
      makeLogLine("error", "An error"),
      makeLogLine("info", "Some info"),
    ]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?level_filter=warn,error");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.level).toBe("warn");
    expect(parsed.entries[1]?.level).toBe("error");
  });

  test("next_offset equals byte position after last line read", async () => {
    const line1 = makeLogLine("error", "Only error");
    const content = line1 + "\n";
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?level_filter=error");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.next_offset).toBe(Buffer.byteLength(content, "utf-8"));
  });

  test("response validates against LogTailResponseSchema", async () => {
    const content = buildJSONL([makeLogLine("error", "Schema test")]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail?level_filter=error");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    // Should not throw
    const parsed = LogTailResponseSchema.parse(body);
    expect(parsed.entries[0]?.component).toBe("test-component");
  });

  test("default level_filter is error,fatal", async () => {
    const content = buildJSONL([
      makeLogLine("error", "Err"),
      makeLogLine("warn", "Warn"),
      makeLogLine("fatal", "Fatal"),
    ]);
    setupMockFile(content);

    const app = createTestApp();
    const res = await app.request("/tail");
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = LogTailResponseSchema.parse(body);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.level)).toEqual(["error", "fatal"]);
  });
});

describe("parseLogLine", () => {
  test("extracts component from context", () => {
    const line = JSON.stringify({
      timestamp: "2026-04-15T16:00:00.000Z",
      level: "error",
      message: "test",
      context: { component: "my-comp" },
    });
    const result = parseLogLine(line);
    expect(result?.component).toBe("my-comp");
  });

  test("extracts error_name from context.error object", () => {
    const line = JSON.stringify({
      timestamp: "2026-04-15T16:00:00.000Z",
      level: "error",
      message: "test",
      context: { error: { name: "TypeError", message: "Cannot read property" } },
    });
    const result = parseLogLine(line);
    expect(result?.error_name).toBe("TypeError");
  });

  test("extracts stack_head (first 3 lines) from stack_trace", () => {
    const stack = "Error: foo\n  at bar (file.ts:1)\n  at baz (file.ts:2)\n  at qux (file.ts:3)";
    const line = JSON.stringify({
      timestamp: "2026-04-15T16:00:00.000Z",
      level: "error",
      message: "test",
      context: {},
      stack_trace: stack,
    });
    const result = parseLogLine(line);
    expect(result?.stack_head).toBe("Error: foo\n  at bar (file.ts:1)\n  at baz (file.ts:2)");
  });

  test("returns undefined for non-JSON", () => {
    expect(parseLogLine("not json")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(parseLogLine("null")).toBeUndefined();
  });
});

describe("fingerprint computation (deterministic)", () => {
  function computeFingerprint(entry: {
    component?: string;
    message: string;
    error_name?: string;
  }): string {
    return `${entry.component ?? "unknown"}::${entry.message.slice(0, 80)}::${entry.error_name ?? "none"}`;
  }

  test("same inputs produce same fingerprint", () => {
    const fp1 = computeFingerprint({
      component: "api",
      message: "Connection refused",
      error_name: "ECONNREFUSED",
    });
    const fp2 = computeFingerprint({
      component: "api",
      message: "Connection refused",
      error_name: "ECONNREFUSED",
    });
    expect(fp1).toBe(fp2);
  });

  test("different messages produce different fingerprints", () => {
    const fp1 = computeFingerprint({ component: "api", message: "Connection refused" });
    const fp2 = computeFingerprint({ component: "api", message: "Connection timeout" });
    expect(fp1).not.toBe(fp2);
  });

  test("message truncation at 80 chars is consistent", () => {
    const longMsg = "A".repeat(200);
    const fp1 = computeFingerprint({ component: "x", message: longMsg });
    const fp2 = computeFingerprint({ component: "x", message: longMsg + "extra" });
    // Both truncate to first 80 chars, which are identical
    expect(fp1).toBe(fp2);
  });

  test("missing component defaults to 'unknown'", () => {
    const fp = computeFingerprint({ message: "test" });
    expect(fp).toMatch(/^unknown::/);
  });

  test("missing error_name defaults to 'none'", () => {
    const fp = computeFingerprint({ component: "x", message: "test" });
    expect(fp).toMatch(/::none$/);
  });
});
