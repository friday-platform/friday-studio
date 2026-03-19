import process from "node:process";
import {
  type ActivityStorageAdapter,
  type ActivityWithReadStatus,
  activityNotifier,
} from "@atlas/activity";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppContext, AppVariables } from "../src/factory.ts";

// Set up auth env BEFORE importing routes
function createTestJwt(payload: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT" };
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode(header)}.${encode(payload)}.`;
}

process.env.ATLAS_KEY = createTestJwt({
  email: "test@example.com",
  sub: "test-user-id",
  user_metadata: { tempest_user_id: "test-tempest-id" },
});
process.env.USER_IDENTITY_ADAPTER = "local";

const { activityRoutes } = await import("./activity.ts");

// ==============================================================================
// Mock adapter factory
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
// Test app with mock adapter injected via middleware
// ==============================================================================

function createTestApp(adapter: ActivityStorageAdapter) {
  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", { getActivityAdapter: () => adapter } as unknown as AppContext);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  return app;
}

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

const UnreadCountResponseSchema = z.object({ count: z.number() });
const SuccessResponseSchema = z.object({ success: z.literal(true) });
const ErrorSchema = z.object({ error: z.string() });

// ==============================================================================
// Fixtures
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

// ==============================================================================
// Tests
// ==============================================================================

let mockAdapter: ActivityStorageAdapter;
let app: Hono<AppVariables>;

beforeEach(() => {
  mockAdapter = createMockActivityAdapter();
  app = createTestApp(mockAdapter);
});

describe("Activity API Routes", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/activity
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /api/activity", () => {
    it("returns empty activities list", async () => {
      const res = await app.request("/api/activity");
      expect(res.status).toBe(200);
      const body = ActivityListResponseSchema.parse(await res.json());
      expect(body.activities).toHaveLength(0);
    });

    it("returns activities from adapter", async () => {
      vi.mocked(mockAdapter.list).mockResolvedValue({
        activities: [sampleActivity],
        hasMore: false,
      });

      const res = await app.request("/api/activity");
      expect(res.status).toBe(200);
      const body = ActivityListResponseSchema.parse(await res.json());
      expect(body.activities).toHaveLength(1);
      expect(body.activities[0]).toMatchObject({
        id: "act-1",
        type: "session",
        title: "Completed deployment task",
      });
    });

    it("passes query filters to adapter", async () => {
      await app.request(
        "/api/activity?type=resource&workspaceId=ws-2&after=2026-01-01T00:00:00Z&before=2026-12-31T23:59:59Z",
      );

      expect(mockAdapter.list).toHaveBeenCalledWith("test-tempest-id", {
        type: "resource",
        workspaceId: "ws-2",
        after: "2026-01-01T00:00:00Z",
        before: "2026-12-31T23:59:59Z",
      });
    });

    it("returns 401 without auth", async () => {
      const savedKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const res = await app.request("/api/activity");
        expect(res.status).toBe(401);
        const body = ErrorSchema.parse(await res.json());
        expect(body.error).toBe("Unauthorized");
      } finally {
        process.env.ATLAS_KEY = savedKey;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/activity/unread-count
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /api/activity/unread-count", () => {
    it("returns count from adapter", async () => {
      vi.mocked(mockAdapter.getUnreadCount).mockResolvedValue(5);

      const res = await app.request("/api/activity/unread-count");
      expect(res.status).toBe(200);
      const body = UnreadCountResponseSchema.parse(await res.json());
      expect(body.count).toBe(5);
    });

    it("returns 401 without auth", async () => {
      const savedKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const res = await app.request("/api/activity/unread-count");
        expect(res.status).toBe(401);
      } finally {
        process.env.ATLAS_KEY = savedKey;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/activity/mark
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /api/activity/mark", () => {
    it("calls updateReadStatus when body has activityIds", async () => {
      const res = await app.request("/api/activity/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityIds: ["act-1", "act-2"], status: "viewed" }),
      });

      expect(res.status).toBe(200);
      SuccessResponseSchema.parse(await res.json());
      expect(mockAdapter.updateReadStatus).toHaveBeenCalledWith(
        "test-tempest-id",
        ["act-1", "act-2"],
        "viewed",
      );
    });

    it("calls updateReadStatus with dismissed status", async () => {
      const res = await app.request("/api/activity/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityIds: ["act-1"], status: "dismissed" }),
      });

      expect(res.status).toBe(200);
      expect(mockAdapter.updateReadStatus).toHaveBeenCalledWith(
        "test-tempest-id",
        ["act-1"],
        "dismissed",
      );
    });

    it("calls markViewedBefore when body has before timestamp", async () => {
      const res = await app.request("/api/activity/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ before: "2026-03-12T00:00:00Z", status: "viewed" }),
      });

      expect(res.status).toBe(200);
      SuccessResponseSchema.parse(await res.json());
      expect(mockAdapter.markViewedBefore).toHaveBeenCalledWith(
        "test-tempest-id",
        "2026-03-12T00:00:00Z",
      );
    });

    it("returns 400 for invalid body", async () => {
      const res = await app.request("/api/activity/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const savedKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const res = await app.request("/api/activity/mark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activityIds: ["act-1"], status: "viewed" }),
        });
        expect(res.status).toBe(401);
      } finally {
        process.env.ATLAS_KEY = savedKey;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/activity/stream
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /api/activity/stream", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns 401 without auth", async () => {
      const savedKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const res = await app.request("/api/activity/stream");
        expect(res.status).toBe(401);
      } finally {
        process.env.ATLAS_KEY = savedKey;
      }
    });

    it("returns SSE headers", async () => {
      const res = await app.request("/api/activity/stream");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("Connection")).toBe("keep-alive");
    });

    it("initial event contains current unread count", async () => {
      vi.mocked(mockAdapter.getUnreadCount).mockResolvedValue(7);

      const res = await app.request("/api/activity/stream");
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain('data: {"count":7}');
      reader.cancel();
    });

    it("sends updated count when notifier fires", async () => {
      let callCount = 0;
      vi.mocked(mockAdapter.getUnreadCount).mockImplementation(() => {
        callCount++;
        // First call returns 3 (initial), second returns 5 (after notify)
        return Promise.resolve(callCount === 1 ? 3 : 5);
      });

      const res = await app.request("/api/activity/stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read initial event
      const { value: first } = await reader.read();
      expect(decoder.decode(first)).toContain('data: {"count":3}');

      // Trigger a notification
      activityNotifier.notify();

      // Read the next event
      const { value: second } = await reader.read();
      expect(decoder.decode(second)).toContain('data: {"count":5}');

      reader.cancel();
    });

    it("deduplicates when count has not changed", async () => {
      vi.mocked(mockAdapter.getUnreadCount).mockResolvedValue(3);

      const res = await app.request("/api/activity/stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read initial event
      const { value: first } = await reader.read();
      expect(decoder.decode(first)).toContain('data: {"count":3}');

      // Trigger notification — count hasn't changed, should not produce event
      activityNotifier.notify();

      // Trigger another notification with different count
      vi.mocked(mockAdapter.getUnreadCount).mockResolvedValue(4);
      activityNotifier.notify();

      const { value: second } = await reader.read();
      expect(decoder.decode(second)).toContain('data: {"count":4}');

      reader.cancel();
    });
  });
});
