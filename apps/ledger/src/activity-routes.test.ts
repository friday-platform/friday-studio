import type { ActivityStorageAdapter, ActivityWithReadStatus } from "@atlas/activity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createApp } from "./index.ts";

// ==============================================================================
// Mock adapter
// ==============================================================================

function createMockActivityAdapter(
  overrides: Partial<ActivityStorageAdapter> = {},
): ActivityStorageAdapter {
  return {
    create: vi.fn<ActivityStorageAdapter["create"]>(),
    deleteByReferenceId: vi
      .fn<ActivityStorageAdapter["deleteByReferenceId"]>()
      .mockResolvedValue(undefined),
    list: vi
      .fn<ActivityStorageAdapter["list"]>()
      .mockResolvedValue({ activities: [], hasMore: false }),
    getUnreadCount: vi.fn<ActivityStorageAdapter["getUnreadCount"]>().mockResolvedValue(0),
    updateReadStatus: vi
      .fn<ActivityStorageAdapter["updateReadStatus"]>()
      .mockResolvedValue(undefined),
    markViewedBefore: vi
      .fn<ActivityStorageAdapter["markViewedBefore"]>()
      .mockResolvedValue(undefined),
    ...overrides,
  };
}

// ==============================================================================
// Setup
// ==============================================================================

const sampleActivity: ActivityWithReadStatus = {
  id: "act-1",
  type: "session",
  source: "agent",
  referenceId: "session-123",
  workspaceId: "ws-1",
  jobId: "job-1",
  userId: null,
  title: "Completed deployment task",
  createdAt: "2026-03-12T10:00:00.000Z",
  readStatus: null,
};

let mockAdapter: ActivityStorageAdapter;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  mockAdapter = createMockActivityAdapter();
  // createApp needs a resource adapter factory (1st arg) and activity adapter factory (2nd arg).
  // Resource adapter is unused by activity routes — pass a no-op factory.
  app = createApp(
    () => ({}) as Parameters<typeof createApp>[0] extends (userId: string) => infer R ? R : never,
    () => mockAdapter,
  );
});

// ==============================================================================
// Response schemas
// ==============================================================================

const ActivityListResponseSchema = z.object({
  activities: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      source: z.string(),
      referenceId: z.string(),
      workspaceId: z.string(),
      jobId: z.string().nullable(),
      userId: z.string().nullable(),
      title: z.string(),
      createdAt: z.string(),
      readStatus: z.string().nullable(),
    }),
  ),
  hasMore: z.boolean(),
});

const UnreadCountSchema = z.object({ count: z.number() });
const SuccessSchema = z.object({ success: z.literal(true) });
const DeletedSchema = z.object({ deleted: z.literal(true) });

// ==============================================================================
// Tests
// ==============================================================================

describe("GET /v1/activity", () => {
  test("returns empty activities list", async () => {
    const res = await app.request("/v1/activity");
    expect(res.status).toBe(200);
    const body = ActivityListResponseSchema.parse(await res.json());
    expect(body.activities).toHaveLength(0);
  });

  test("returns activities from adapter", async () => {
    vi.mocked(mockAdapter.list).mockResolvedValue({ activities: [sampleActivity], hasMore: true });

    const res = await app.request("/v1/activity");
    expect(res.status).toBe(200);
    const body = ActivityListResponseSchema.parse(await res.json());
    expect(body.activities).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(body.activities[0]).toMatchObject({ id: "act-1", type: "session" });
  });

  test("passes query filters to adapter", async () => {
    await app.request("/v1/activity?type=resource&workspaceId=ws-2&limit=10&offset=5");

    expect(mockAdapter.list).toHaveBeenCalledWith("dev", {
      type: "resource",
      workspaceId: "ws-2",
      limit: 10,
      offset: 5,
    });
  });
});

describe("GET /v1/activity/unread-count", () => {
  test("returns count from adapter", async () => {
    vi.mocked(mockAdapter.getUnreadCount).mockResolvedValue(7);

    const res = await app.request("/v1/activity/unread-count");
    expect(res.status).toBe(200);
    const body = UnreadCountSchema.parse(await res.json());
    expect(body.count).toBe(7);
  });
});

describe("POST /v1/activity/mark", () => {
  test("calls updateReadStatus when body has activityIds", async () => {
    const res = await app.request("/v1/activity/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activityIds: ["act-1", "act-2"], status: "viewed" }),
    });

    expect(res.status).toBe(200);
    SuccessSchema.parse(await res.json());
    expect(mockAdapter.updateReadStatus).toHaveBeenCalledWith("dev", ["act-1", "act-2"], "viewed");
  });

  test("calls markViewedBefore when body has before timestamp", async () => {
    const res = await app.request("/v1/activity/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ before: "2026-03-12T00:00:00Z", status: "viewed" }),
    });

    expect(res.status).toBe(200);
    SuccessSchema.parse(await res.json());
    expect(mockAdapter.markViewedBefore).toHaveBeenCalledWith("dev", "2026-03-12T00:00:00Z");
  });

  test("returns 400 for invalid body", async () => {
    const res = await app.request("/v1/activity/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/activity", () => {
  test("creates activity and returns 201", async () => {
    const input = {
      type: "session" as const,
      source: "agent" as const,
      referenceId: "session-456",
      workspaceId: "ws-1",
      jobId: null,
      userId: null,
      title: "New session started",
    };
    vi.mocked(mockAdapter.create).mockResolvedValue({
      id: "act-new",
      ...input,
      createdAt: "2026-03-12T10:00:00Z",
    });

    const res = await app.request("/v1/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ id: "act-new", type: "session" });
    expect(mockAdapter.create).toHaveBeenCalledWith(input);
  });

  test("returns 400 for missing fields", async () => {
    const res = await app.request("/v1/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "session" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/activity/by-reference/:referenceId", () => {
  test("deletes by reference ID", async () => {
    const res = await app.request("/v1/activity/by-reference/ref-123", { method: "DELETE" });

    expect(res.status).toBe(200);
    DeletedSchema.parse(await res.json());
    expect(mockAdapter.deleteByReferenceId).toHaveBeenCalledWith("ref-123");
  });
});
