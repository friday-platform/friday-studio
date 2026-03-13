import type { PublishedResourceInfo, ResourceStorageAdapter } from "@atlas/ledger";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { publishDirtyDrafts } from "./publish-hook.ts";

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@atlas/logger", () => ({ logger: mockLogger, createLogger: vi.fn(() => mockLogger) }));

const WORKSPACE = "ws-test-1";

function createMockAdapter(
  publishAllDirtyFn?: (ws: string) => Promise<PublishedResourceInfo[]>,
): ResourceStorageAdapter {
  return {
    init: vi.fn<() => Promise<void>>(),
    destroy: vi.fn<() => Promise<void>>(),
    provision: vi.fn(),
    query: vi.fn(),
    mutate: vi.fn(),
    publish: vi.fn(),
    replaceVersion: vi.fn(),
    listResources: vi.fn(),
    getResource: vi.fn(),
    deleteResource: vi.fn(),
    linkRef: vi.fn(),
    resetDraft: vi.fn(),
    publishAllDirty: vi.fn<(ws: string) => Promise<PublishedResourceInfo[]>>(
      publishAllDirtyFn ?? (() => Promise.resolve([])),
    ),
    getSkill: vi.fn<() => Promise<string>>().mockResolvedValue(""),
  };
}

const threeResources: PublishedResourceInfo[] = [
  { resourceId: "r1", slug: "res-1" },
  { resourceId: "r2", slug: "res-2" },
  { resourceId: "r3", slug: "res-3" },
];

describe("publishDirtyDrafts", () => {
  beforeEach(() => {
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
  });

  test("calls publishAllDirty with the workspace ID", async () => {
    const adapter = createMockAdapter();

    await publishDirtyDrafts(adapter, WORKSPACE);

    expect(adapter.publishAllDirty).toHaveBeenCalledWith(WORKSPACE);
  });

  test("no-op log when no dirty drafts — returns empty array", async () => {
    const adapter = createMockAdapter(() => Promise.resolve([]));

    await publishDirtyDrafts(adapter, WORKSPACE);

    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test("logs debug with published count when dirty drafts exist", async () => {
    const adapter = createMockAdapter(() => Promise.resolve(threeResources));

    await publishDirtyDrafts(adapter, WORKSPACE);

    expect(mockLogger.debug).toHaveBeenCalledWith("Auto-published dirty drafts", {
      workspaceId: WORKSPACE,
      published: 3,
    });
  });

  test("logs warn and does not throw when publishAllDirty fails", async () => {
    const adapter = createMockAdapter(() => Promise.reject(new Error("connection refused")));

    await expect(publishDirtyDrafts(adapter, WORKSPACE)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith("Auto-publish failed for workspace", {
      workspaceId: WORKSPACE,
      error: "connection refused",
    });
  });

  test("does not call individual publish — uses batch method only", async () => {
    const adapter = createMockAdapter(() =>
      Promise.resolve([
        { resourceId: "r1", slug: "s1" },
        { resourceId: "r2", slug: "s2" },
      ]),
    );

    await publishDirtyDrafts(adapter, WORKSPACE);

    expect(adapter.publish).not.toHaveBeenCalled();
    expect(adapter.listResources).not.toHaveBeenCalled();
  });
});
