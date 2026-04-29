/**
 * Tests for fetchAndValidateArtifacts — verifies filtering behavior:
 * keeps database artifacts, skips non-database with warning, throws
 * when no database artifacts remain.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchAndValidateArtifacts } from "./agent.ts";

// ---------------------------------------------------------------------------
// Mock ArtifactStorage
// ---------------------------------------------------------------------------

const getManyLatestMock = vi.hoisted(() => vi.fn());

vi.mock("@atlas/core/artifacts/server", () => ({
  ArtifactStorage: { getManyLatest: getManyLatestMock },
}));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

afterEach(() => {
  getManyLatestMock.mockReset();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(id: string, type: string) {
  return {
    id,
    type,
    revision: 1,
    data: { type, version: 1, data: {} },
    title: `test-${id}`,
    summary: "test",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchAndValidateArtifacts", () => {
  test("returns only database artifacts from mixed types", async () => {
    const dbArtifact = makeArtifact("db-1", "database");
    const fileArtifact = makeArtifact("file-1", "file");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [dbArtifact, fileArtifact] });

    const result = await fetchAndValidateArtifacts(["db-1", "file-1"], mockLogger as never);

    expect(result).toEqual([dbArtifact]);
    expect(mockLogger.warn).toHaveBeenCalledWith("Skipping non-database artifact", {
      id: "file-1",
      type: "file",
    });
  });

  test("throws when all artifacts are non-database", async () => {
    const fileArtifact = makeArtifact("file-1", "file");
    getManyLatestMock.mockResolvedValue({ ok: true, data: [fileArtifact] });

    await expect(fetchAndValidateArtifacts(["file-1"], mockLogger as never)).rejects.toThrow(
      "No database artifacts found",
    );
  });

  test("throws when all artifact IDs are missing", async () => {
    getManyLatestMock.mockResolvedValue({ ok: true, data: [] });

    await expect(fetchAndValidateArtifacts(["missing-1"], mockLogger as never)).rejects.toThrow(
      "No database artifacts found",
    );
    expect(mockLogger.warn).toHaveBeenCalledWith("Artifact not found, skipping", {
      id: "missing-1",
    });
  });

  test("throws on empty artifact IDs array", async () => {
    await expect(fetchAndValidateArtifacts([], mockLogger as never)).rejects.toThrow(
      "No artifact IDs found in prompt",
    );
  });

  test("throws when storage returns error", async () => {
    getManyLatestMock.mockResolvedValue({ ok: false, error: "storage unavailable" });

    await expect(fetchAndValidateArtifacts(["id-1"], mockLogger as never)).rejects.toThrow(
      "Failed to fetch artifacts: storage unavailable",
    );
  });
});
