import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalActivityAdapter } from "./local-adapter.ts";
import type { CreateActivityInput } from "./schemas.ts";
import {
  ActivitySchema,
  ActivityWithReadStatusSchema,
  CreateActivityInputSchema,
} from "./schemas.ts";

describe("LocalActivityAdapter", () => {
  let adapter: LocalActivityAdapter;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `activity-test-${Date.now()}.db`);
    adapter = new LocalActivityAdapter(dbPath);
  });

  afterEach(() => {
    try {
      rmSync(dbPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  function makeInput(overrides?: Partial<CreateActivityInput>): CreateActivityInput {
    return CreateActivityInputSchema.parse({
      type: "session",
      source: "agent",
      referenceId: "ref-1",
      workspaceId: "ws-1",
      jobId: null,
      userId: "user-1",
      title: "Test activity",
      ...overrides,
    });
  }

  describe("create", () => {
    it("creates an activity and returns it", async () => {
      const input = makeInput();
      const result = await adapter.create(input);

      const parsed = ActivitySchema.parse(result);
      expect(parsed.id).toBeTruthy();
      expect(parsed.type).toBe("session");
      expect(parsed.source).toBe("agent");
      expect(parsed.referenceId).toBe("ref-1");
      expect(parsed.workspaceId).toBe("ws-1");
      expect(parsed.title).toBe("Test activity");
      expect(parsed.createdAt).toBeTruthy();
    });
  });

  describe("list", () => {
    it("creates activity and retrieves via list", async () => {
      const input = makeInput();
      await adapter.create(input);

      const { activities, hasMore } = await adapter.list("user-1");
      expect(activities).toHaveLength(1);
      expect(hasMore).toBe(false);
      const parsed = ActivityWithReadStatusSchema.parse(activities[0]);
      expect(parsed.type).toBe("session");
      expect(parsed.readStatus).toBeNull();
    });

    it("filters by type", async () => {
      await adapter.create(makeInput({ type: "session", referenceId: "s1" }));
      await adapter.create(makeInput({ type: "resource", referenceId: "r1" }));

      const sessions = await adapter.list("user-1", { type: "session" });
      expect(sessions.activities).toHaveLength(1);
      expect(sessions.activities[0]?.type).toBe("session");

      const resources = await adapter.list("user-1", { type: "resource" });
      expect(resources.activities).toHaveLength(1);
      expect(resources.activities[0]?.type).toBe("resource");
    });

    it("filters by workspaceId", async () => {
      await adapter.create(makeInput({ workspaceId: "ws-1" }));
      await adapter.create(makeInput({ workspaceId: "ws-2", referenceId: "ref-2" }));

      const result = await adapter.list("user-1", { workspaceId: "ws-1" });
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]?.workspaceId).toBe("ws-1");
    });

    it("filters by date range", async () => {
      const a1 = await adapter.create(makeInput({ referenceId: "old" }));
      // Ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));
      const a2 = await adapter.create(makeInput({ referenceId: "new" }));

      // After the first one's timestamp should return the second
      const afterFirst = await adapter.list("user-1", { after: a1.createdAt });
      expect(afterFirst.activities).toHaveLength(1);
      expect(afterFirst.activities[0]?.referenceId).toBe("new");

      // Before the second one's timestamp should return the first
      const beforeSecond = await adapter.list("user-1", { before: a2.createdAt });
      expect(beforeSecond.activities).toHaveLength(1);
      expect(beforeSecond.activities[0]?.referenceId).toBe("old");
    });

    it("returns items in descending order by createdAt", async () => {
      await adapter.create(makeInput({ referenceId: "first" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await adapter.create(makeInput({ referenceId: "second" }));

      const { activities } = await adapter.list("user-1");
      expect(activities).toHaveLength(2);
      expect(activities[0]?.referenceId).toBe("second");
      expect(activities[1]?.referenceId).toBe("first");
    });

    it("returns hasMore when more items exist beyond the limit", async () => {
      await adapter.create(makeInput({ referenceId: "a1" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await adapter.create(makeInput({ referenceId: "a2" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await adapter.create(makeInput({ referenceId: "a3" }));

      const page1 = await adapter.list("user-1", { limit: 2 });
      expect(page1.activities).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await adapter.list("user-1", { limit: 2, offset: 2 });
      expect(page2.activities).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe("unread count", () => {
    it("counts activities with no read status as unread", async () => {
      await adapter.create(makeInput({ referenceId: "a1" }));
      await adapter.create(makeInput({ referenceId: "a2" }));

      const count = await adapter.getUnreadCount("user-1");
      expect(count).toBe(2);
    });

    it("returns 0 when all are read", async () => {
      const a1 = await adapter.create(makeInput({ referenceId: "a1" }));
      await adapter.updateReadStatus("user-1", [a1.id], "viewed");

      const count = await adapter.getUnreadCount("user-1");
      expect(count).toBe(0);
    });

    it("scopes to workspace when workspaceId is provided", async () => {
      await adapter.create(makeInput({ workspaceId: "ws-1", referenceId: "a1" }));
      await adapter.create(makeInput({ workspaceId: "ws-2", referenceId: "a2" }));

      expect(await adapter.getUnreadCount("user-1", "ws-1")).toBe(1);
      expect(await adapter.getUnreadCount("user-1", "ws-2")).toBe(1);
    });

    it("returns global count when workspaceId is omitted", async () => {
      await adapter.create(makeInput({ workspaceId: "ws-1", referenceId: "a1" }));
      await adapter.create(makeInput({ workspaceId: "ws-2", referenceId: "a2" }));

      expect(await adapter.getUnreadCount("user-1")).toBe(2);
    });
  });

  describe("updateReadStatus", () => {
    it("inserts viewed/dismissed status and changes unread count", async () => {
      const a1 = await adapter.create(makeInput({ referenceId: "a1" }));
      const a2 = await adapter.create(makeInput({ referenceId: "a2" }));

      expect(await adapter.getUnreadCount("user-1")).toBe(2);

      await adapter.updateReadStatus("user-1", [a1.id], "viewed");
      expect(await adapter.getUnreadCount("user-1")).toBe(1);

      await adapter.updateReadStatus("user-1", [a2.id], "dismissed");
      expect(await adapter.getUnreadCount("user-1")).toBe(0);

      // Verify list shows read statuses
      const { activities } = await adapter.list("user-1");
      const dismissed = activities.find((i) => i.referenceId === "a2");
      expect(dismissed?.readStatus).toBe("dismissed");
    });

    it("updates existing status via upsert", async () => {
      const a1 = await adapter.create(makeInput());
      await adapter.updateReadStatus("user-1", [a1.id], "viewed");
      await adapter.updateReadStatus("user-1", [a1.id], "dismissed");

      const { activities } = await adapter.list("user-1");
      expect(activities[0]?.readStatus).toBe("dismissed");
    });

    it("does nothing for empty activityIds array", async () => {
      await adapter.updateReadStatus("user-1", [], "viewed");
      // No error thrown
    });
  });

  describe("markViewedBefore", () => {
    it("marks items before timestamp as viewed, leaves newer unread", async () => {
      await adapter.create(makeInput({ referenceId: "old" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const cutoff = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await adapter.create(makeInput({ referenceId: "new" }));

      await adapter.markViewedBefore("user-1", cutoff);

      // The old item should now be viewed
      const { activities } = await adapter.list("user-1");
      const oldItem = activities.find((i) => i.referenceId === "old");
      const newItem = activities.find((i) => i.referenceId === "new");
      expect(oldItem?.readStatus).toBe("viewed");
      expect(newItem?.readStatus).toBeNull();

      // Unread count should be 1 (only the newer one)
      expect(await adapter.getUnreadCount("user-1")).toBe(1);
    });

    it("does not overwrite existing read status", async () => {
      const a1 = await adapter.create(makeInput());
      await adapter.updateReadStatus("user-1", [a1.id], "dismissed");

      // Mark before a future timestamp — should skip already-read items
      await adapter.markViewedBefore("user-1", new Date(Date.now() + 10000).toISOString());

      const { activities } = await adapter.list("user-1");
      expect(activities[0]?.readStatus).toBe("dismissed");
    });

    it("scopes to workspace when workspaceId is provided", async () => {
      await adapter.create(makeInput({ workspaceId: "ws-1", referenceId: "a1" }));
      await adapter.create(makeInput({ workspaceId: "ws-2", referenceId: "a2" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const cutoff = new Date().toISOString();

      await adapter.markViewedBefore("user-1", cutoff, "ws-1");

      const { activities } = await adapter.list("user-1");
      const ws1Item = activities.find((i) => i.referenceId === "a1");
      const ws2Item = activities.find((i) => i.referenceId === "a2");
      expect(ws1Item?.readStatus).toBe("viewed");
      expect(ws2Item?.readStatus).toBeNull();
    });

    it("marks all workspaces when workspaceId is omitted", async () => {
      await adapter.create(makeInput({ workspaceId: "ws-1", referenceId: "a1" }));
      await adapter.create(makeInput({ workspaceId: "ws-2", referenceId: "a2" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const cutoff = new Date().toISOString();

      await adapter.markViewedBefore("user-1", cutoff);

      expect(await adapter.getUnreadCount("user-1")).toBe(0);
    });
  });

  describe("user-initiated activity auto-viewed", () => {
    it("auto-inserts viewed status for user-initiated activities", async () => {
      await adapter.create(
        makeInput({ source: "user", userId: "user-1", title: "User did something" }),
      );

      // Unread count for the actor should be 0
      const count = await adapter.getUnreadCount("user-1");
      expect(count).toBe(0);

      // But unread for a different user should be 1
      const otherCount = await adapter.getUnreadCount("user-2");
      expect(otherCount).toBe(1);
    });

    it("does not auto-view agent-initiated activities", async () => {
      await adapter.create(makeInput({ source: "agent", userId: "user-1" }));

      const count = await adapter.getUnreadCount("user-1");
      expect(count).toBe(1);
    });

    it("list shows viewed status for auto-viewed items", async () => {
      await adapter.create(makeInput({ source: "user", userId: "user-1" }));

      const { activities } = await adapter.list("user-1");
      expect(activities[0]?.readStatus).toBe("viewed");
    });
  });

  describe("schema validation", () => {
    it("all returned activities validate against Zod schemas", async () => {
      await adapter.create(makeInput({ type: "session", source: "agent" }));
      await adapter.create(
        makeInput({ type: "resource", source: "user", userId: "user-1", referenceId: "r2" }),
      );

      const { activities } = await adapter.list("user-1");
      for (const item of activities) {
        expect(() => ActivityWithReadStatusSchema.parse(item)).not.toThrow();
      }
    });
  });
});
